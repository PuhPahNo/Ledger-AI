import { and, eq, sql } from 'drizzle-orm';
import {
  Configuration,
  CountryCode,
  PlaidApi,
  PlaidEnvironments,
  Products,
} from 'plaid';
import { getEnv } from '../config/env.js';
import { db } from '../db/client.js';
import {
  accounts,
  archivedTransactions,
  categories,
  connections,
  receiptMatches,
  receipts,
  transactions,
  type Transaction,
} from '../db/schema.js';
import { decryptText, encryptText } from '../lib/crypto.js';
import { serviceUnavailable } from '../lib/errors.js';
import { resolveTransactionBusinessId } from './accountAssignment.js';
import { categorizeTransactionWithDetails, isExcludedFromSpendCategory } from './categorization.js';
import { createAiCategorySuggestionReview } from './categorizationFeedback.js';
import { applyTagRulesToTransaction } from './tagging.js';
import { getReceiptTrackingSince } from './appSettings.js';

export const PLAID_TRANSACTION_HISTORY_DAYS = 365;

export function plaidClient(): PlaidApi | null {
  const env = getEnv();
  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET) return null;
  return new PlaidApi(new Configuration({
    basePath: PlaidEnvironments[env.PLAID_ENV],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': env.PLAID_CLIENT_ID,
        'PLAID-SECRET': env.PLAID_SECRET,
      },
    },
  }));
}

export async function createPlaidLinkToken(userId: string): Promise<{ link_token: string; expiration: string }> {
  const client = plaidClient();
  if (!client) {
    serviceUnavailable('Plaid is not configured. Add PLAID_CLIENT_ID and PLAID_SECRET in Render, then redeploy.');
  }
  const env = getEnv();
  const res = await client.linkTokenCreate({
    user: { client_user_id: userId },
    client_name: 'Ledger AI',
    products: [Products.Transactions],
    country_codes: [CountryCode.Us],
    language: 'en',
    webhook: env.PLAID_WEBHOOK_URL || undefined,
    transactions: {
      days_requested: PLAID_TRANSACTION_HISTORY_DAYS,
    },
  });
  return res.data;
}

export async function exchangePlaidPublicToken(input: {
  publicToken: string;
  businessId?: string;
}): Promise<string> {
  const client = plaidClient();
  if (!client) throw new Error('Plaid is not configured');
  const exchange = await client.itemPublicTokenExchange({ public_token: input.publicToken });
  const accessToken = exchange.data.access_token;
  const itemId = exchange.data.item_id;
  const item = await client.itemGet({ access_token: accessToken });
  const label = item.data.item.institution_id ?? 'Plaid connection';

  const [connection] = await db.insert(connections).values({
    businessId: input.businessId,
    kind: 'bank',
    label,
    status: 'live',
    providerItemId: itemId,
    encryptedAccessToken: encryptText(accessToken),
  }).returning();

  return connection.id;
}

export interface PlaidSyncResult {
  /** Transactions newly inserted this run. */
  added: number;
  /** Existing transactions Plaid modified or removed this run — amounts, dates, and receipt
   * links may have shifted, so unmatched receipts deserve another pass. */
  changed: number;
}

export async function syncPlaidConnection(
  connectionId: string,
  options: {
    resetCursor?: boolean;
    daysRequested?: number;
    allowAiCategorization?: boolean;
  } = {},
): Promise<PlaidSyncResult> {
  const client = plaidClient();
  if (!client) return { added: 0, changed: 0 };
  const connection = await db.query.connections.findFirst({ where: eq(connections.id, connectionId) });
  if (!connection?.encryptedAccessToken) return { added: 0, changed: 0 };
  const accessToken = decryptText(connection.encryptedAccessToken);

  let cursor: string | undefined = options.resetCursor ? undefined : connection.plaidCursor ?? undefined;
  let addedCount = 0;
  let changedCount = 0;
  let hasMore = true;
  // Spend dated before this cutoff isn't expected to have a receipt (imported as 'waived').
  const receiptTrackingSince = await getReceiptTrackingSince();

  while (hasMore) {
    let data;
    try {
      const res = await client.transactionsSync({
        access_token: accessToken,
        cursor,
        count: 500,
        options: options.daysRequested ? { days_requested: options.daysRequested } : undefined,
      });
      data = res.data;
    } catch (error) {
      // Expired bank credentials would otherwise fail silently forever: flag the
      // connection so the scheduler skips it and the UI can prompt a re-link.
      if (isPlaidReauthError(error)) {
        await db.update(connections).set({ status: 'reauth', updatedAt: new Date() }).where(eq(connections.id, connectionId));
      }
      throw error;
    }
    await upsertAccounts(connectionId, connection.businessId ?? undefined, data.accounts ?? []);
    for (const txn of data.added ?? []) {
      const inserted = await upsertTransaction(connectionId, connection.businessId ?? undefined, txn, {
        allowAiCategorization: options.allowAiCategorization,
        receiptTrackingSince,
      });
      if (inserted) addedCount += 1;
    }
    for (const txn of data.modified ?? []) {
      await upsertTransaction(connectionId, connection.businessId ?? undefined, txn, {
        allowAiCategorization: options.allowAiCategorization,
        receiptTrackingSince,
      });
      changedCount += 1;
    }
    for (const removed of data.removed ?? []) {
      const archived = await archiveRemovedPlaidTransaction(removed.transaction_id);
      if (archived) changedCount += 1;
    }
    cursor = data.next_cursor;
    hasMore = data.has_more;
  }

  await db.update(connections).set({
    plaidCursor: cursor,
    lastSyncAt: new Date(),
    syncedTransactionCount: (connection.syncedTransactionCount ?? 0) + addedCount,
    updatedAt: new Date(),
  }).where(eq(connections.id, connectionId));

  return { added: addedCount, changed: changedCount };
}

const PLAID_REAUTH_ERROR_CODES = new Set([
  'ITEM_LOGIN_REQUIRED',
  'ITEM_LOCKED',
  'USER_PERMISSION_REVOKED',
  'ACCESS_NOT_GRANTED',
]);

function isPlaidReauthError(error: unknown): boolean {
  const data = (error as { response?: { data?: { error_code?: unknown } } })?.response?.data;
  return typeof data?.error_code === 'string' && PLAID_REAUTH_ERROR_CODES.has(data.error_code);
}

/**
 * Plaid "removed" isn't only user-visible deletions — it's also how every pending
 * transaction exits when it posts (the posted copy arrives in `added` with
 * pending_transaction_id). Snapshot the row instead of losing its history, and free any
 * receipt still pointing at it so the rematch sweep can re-pair it with the posted copy.
 */
async function archiveRemovedPlaidTransaction(plaidTransactionId: string): Promise<boolean> {
  const existing = await db.query.transactions.findFirst({
    where: eq(transactions.plaidTransactionId, plaidTransactionId),
  });
  if (!existing) return false;

  await db.insert(archivedTransactions).values({
    originalTransactionId: existing.id,
    plaidTransactionId,
    businessId: existing.businessId,
    reason: 'plaid_removed',
    snapshot: existing as unknown as Record<string, unknown>,
  });

  if (existing.receiptId) {
    await db
      .update(receipts)
      .set({ transactionId: null, status: 'pending', updatedAt: new Date() })
      .where(and(eq(receipts.id, existing.receiptId), eq(receipts.transactionId, existing.id)));
  }

  await db.delete(transactions).where(eq(transactions.id, existing.id));
  return true;
}

async function upsertAccounts(connectionId: string, businessId: string | undefined, plaidAccounts: unknown[]): Promise<void> {
  for (const raw of plaidAccounts as Array<Record<string, any>>) {
    await db.insert(accounts).values({
      connectionId,
      businessId,
      plaidAccountId: raw.account_id,
      name: raw.name ?? raw.official_name ?? 'Account',
      officialName: raw.official_name,
      mask: raw.mask,
      kind: mapAccountKind(raw.type, raw.subtype),
      currentBalanceCents: plaidBalanceCents(raw.balances?.current),
      availableBalanceCents: plaidBalanceCents(raw.balances?.available),
    }).onConflictDoUpdate({
      target: accounts.plaidAccountId,
      set: {
        businessId: sql`coalesce(${accounts.businessId}, excluded.business_id)`,
        name: raw.name ?? raw.official_name ?? 'Account',
        officialName: raw.official_name,
        mask: raw.mask,
        kind: mapAccountKind(raw.type, raw.subtype),
        currentBalanceCents: plaidBalanceCents(raw.balances?.current),
        availableBalanceCents: plaidBalanceCents(raw.balances?.available),
        updatedAt: new Date(),
      },
    });
  }
}

async function upsertTransaction(
  connectionId: string,
  fallbackBusinessId: string | undefined,
  raw: Record<string, any>,
  options: { allowAiCategorization?: boolean; receiptTrackingSince?: string | null } = {},
): Promise<boolean> {
  const account = await db.query.accounts.findFirst({ where: eq(accounts.plaidAccountId, raw.account_id) });
  const businessId = resolveTransactionBusinessId(account?.businessId, fallbackBusinessId);
  if (!businessId) return false;
  const amountCents = plaidAmountCents(raw);
  const existing = raw.transaction_id
    ? await db.query.transactions.findFirst({
      where: eq(transactions.plaidTransactionId, raw.transaction_id),
      columns: { id: true },
    })
    : null;
  // When a pending transaction posts, Plaid sends a brand-new row referencing the old one.
  // Inherit protected categorization instead of re-categorizing (and re-spending AI) from scratch.
  const predecessor = typeof raw.pending_transaction_id === 'string' && raw.pending_transaction_id
    ? await db.query.transactions.findFirst({
      where: eq(transactions.plaidTransactionId, raw.pending_transaction_id),
    })
    : null;
  const inherited = predecessor && isProtectedCategorySource(predecessor.categorySource) ? predecessor : null;
  const categorization = inherited
    ? {
      categoryId: inherited.categoryId,
      source: inherited.categorySource,
      confidence: inherited.categoryConfidence == null ? null : Number(inherited.categoryConfidence),
      evidence: {
        reason: 'inherited_from_pending_transaction',
        predecessorTransactionId: inherited.id,
      } as Record<string, unknown>,
    }
    : await categorizeTransactionWithDetails({
      businessId,
      merchant: raw.merchant_name ?? raw.name ?? 'Unknown merchant',
      amountCents,
      plaidCategory: plaidCategoryHints(raw),
      allowAi: options.allowAiCategorization,
    });
  const shouldReviewAi = categorization.source === 'ai_suggested' && (categorization.confidence ?? 0) < 0.85;
  const uncategorizedCategoryId = shouldReviewAi ? await fallbackUncategorizedCategoryId() : null;
  const appliedCategoryId = shouldReviewAi ? uncategorizedCategoryId : categorization.categoryId;
  const appliedCategorySource = shouldReviewAi ? 'uncategorized' : categorization.source;
  const appliedCategoryConfidence = shouldReviewAi ? null : categorization.confidence;
  const appliedCategoryEvidence = shouldReviewAi
    ? { reason: 'ai_suggestion_deferred_to_review', suggestion: categorization }
    : categorization.evidence;
  const receiptStatus = await receiptStatusForPlaidTransaction(
    amountCents,
    appliedCategoryId,
    raw.date,
    options.receiptTrackingSince ?? null,
  );
  const sourceLabel = account ? `${account.name}${account.mask ? ` ${account.mask}` : ''}` : `Plaid ${connectionId.slice(0, 8)}`;

  const [saved] = await db.insert(transactions).values({
    businessId,
    accountId: account?.id,
    plaidTransactionId: raw.transaction_id,
    date: raw.date,
    authorizedDate: raw.authorized_date,
    merchant: raw.merchant_name ?? raw.name ?? 'Unknown merchant',
    amountCents,
    categoryId: appliedCategoryId,
    categorySource: appliedCategorySource,
    categoryConfidence: appliedCategoryConfidence == null ? null : appliedCategoryConfidence.toFixed(4),
    categoryEvidence: appliedCategoryEvidence,
    receiptStatus,
    sourceLabel,
    pending: Boolean(raw.pending),
    raw,
  }).onConflictDoUpdate({
    target: transactions.plaidTransactionId,
    set: {
      date: raw.date,
      authorizedDate: raw.authorized_date,
      merchant: raw.merchant_name ?? raw.name ?? 'Unknown merchant',
      amountCents,
      categoryId: sql`CASE
        WHEN ${transactions.categorySource} IN ('manual', 'user_confirmed_rule', 'receipt_evidence')
          THEN ${transactions.categoryId}
        ELSE excluded.category_id
      END`,
      categorySource: sql`CASE
        WHEN ${transactions.categorySource} IN ('manual', 'user_confirmed_rule', 'receipt_evidence')
          THEN ${transactions.categorySource}
        ELSE excluded.category_source
      END`,
      categoryConfidence: sql`CASE
        WHEN ${transactions.categorySource} IN ('manual', 'user_confirmed_rule', 'receipt_evidence')
          THEN ${transactions.categoryConfidence}
        ELSE excluded.category_confidence
      END`,
      receiptStatus: sql`CASE
        WHEN ${transactions.receiptStatus} IN ('matched', 'waived')
          THEN ${transactions.receiptStatus}
        WHEN ${transactions.categorySource} IN ('manual', 'user_confirmed_rule', 'receipt_evidence')
          THEN ${transactions.receiptStatus}
        ELSE excluded.receipt_status
      END`,
      categoryEvidence: sql`CASE
        WHEN ${transactions.categorySource} IN ('manual', 'user_confirmed_rule', 'receipt_evidence')
          THEN ${transactions.categoryEvidence}
        ELSE excluded.category_evidence
      END`,
      pending: Boolean(raw.pending),
      raw,
      updatedAt: new Date(),
    },
  }).returning();

  if (shouldReviewAi && saved?.categorySource === 'uncategorized') {
    await createAiCategorySuggestionReview(saved, categorization);
  }
  if (predecessor && saved && predecessor.id !== saved.id) {
    await adoptPendingPredecessor(predecessor, saved);
  }
  if (saved) {
    // Tagging is best-effort layered metadata — a bad tag rule must not fail the sync.
    try {
      await applyTagRulesToTransaction(saved);
    } catch (error) {
      console.error(`Tag rules failed for transaction ${saved.id}`, error);
    }
  }
  return !existing;
}

const PROTECTED_CATEGORY_SOURCES = new Set(['manual', 'user_confirmed_rule', 'receipt_evidence']);

function isProtectedCategorySource(source: string | null | undefined): boolean {
  return source != null && PROTECTED_CATEGORY_SOURCES.has(source);
}

/**
 * Carry the user's work from a pending transaction onto its posted replacement: the matched
 * receipt (plus its match records), notes, and flags. Protected categorization is inherited
 * earlier, before the row is written. The pending row loses its receipt pointer here and is
 * archived when Plaid's `removed` entry for it arrives (usually in the same sync).
 */
async function adoptPendingPredecessor(predecessor: Transaction, saved: Transaction): Promise<void> {
  if (predecessor.receiptId && !saved.receiptId) {
    const receipt = await db.query.receipts.findFirst({
      where: and(eq(receipts.id, predecessor.receiptId), eq(receipts.transactionId, predecessor.id)),
    });
    if (receipt) {
      await db
        .update(receipts)
        .set({ transactionId: saved.id, updatedAt: new Date() })
        .where(eq(receipts.id, receipt.id));
      await db
        .update(receiptMatches)
        .set({ transactionId: saved.id })
        .where(and(eq(receiptMatches.receiptId, receipt.id), eq(receiptMatches.transactionId, predecessor.id)));
      await db
        .update(transactions)
        .set({ receiptId: receipt.id, receiptStatus: 'matched', updatedAt: new Date() })
        .where(eq(transactions.id, saved.id));
      await db
        .update(transactions)
        .set({ receiptId: null, updatedAt: new Date() })
        .where(eq(transactions.id, predecessor.id));
    }
  }

  const carry: { note?: string; flag?: string } = {};
  if (predecessor.note && !saved.note) carry.note = predecessor.note;
  if (predecessor.flag && !saved.flag) carry.flag = predecessor.flag;
  if (Object.keys(carry).length > 0) {
    await db
      .update(transactions)
      .set({ ...carry, updatedAt: new Date() })
      .where(eq(transactions.id, saved.id));
  }
}

async function receiptStatusForPlaidTransaction(
  amountCents: number,
  categoryId: string | null,
  date: string | null | undefined,
  receiptTrackingSince: string | null,
): Promise<'missing' | 'n/a' | 'waived'> {
  if (amountCents >= 0) return 'n/a';
  if (categoryId) {
    const category = await db.query.categories.findFirst({ where: eq(categories.id, categoryId) });
    if (category && isExcludedFromSpendCategory(category)) return 'n/a';
  }
  // Spend that predates receipt tracking isn't expected to have a receipt.
  if (receiptTrackingSince && date && date < receiptTrackingSince) return 'waived';
  return 'missing';
}

async function fallbackUncategorizedCategoryId(): Promise<string | null> {
  const uncategorized = await db.query.categories.findFirst({
    where: sql`${categories.businessId} IS NULL AND ${categories.name} = 'Uncategorized'`,
  });
  return uncategorized?.id ?? null;
}

function plaidCategoryHints(raw: Record<string, any>): string[] {
  const personalFinanceCategory = raw.personal_finance_category ?? {};
  return [
    ...(Array.isArray(raw.category) ? raw.category : []),
    personalFinanceCategory.primary,
    personalFinanceCategory.detailed,
    personalFinanceCategory.confidence_level,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
}

export function plaidBalanceCents(value: unknown): number | null {
  if (value == null) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  return Math.round(amount * 100);
}

export function plaidAmountCents(raw: Record<string, any>): number {
  const plaidAmount = Number(raw.amount);
  if (!Number.isFinite(plaidAmount)) return 0;
  const defaultCents = -Math.round(plaidAmount * 100);
  const direction = plaidDirectionHint(raw);
  if (direction === 'inflow') return Math.abs(defaultCents);
  if (direction === 'outflow') return -Math.abs(defaultCents);
  return defaultCents;
}

function plaidDirectionHint(raw: Record<string, any>): 'inflow' | 'outflow' | null {
  const personalFinanceCategory = raw.personal_finance_category ?? {};
  const primary = normalizePlaidToken(personalFinanceCategory.primary);
  const detailed = normalizePlaidToken(personalFinanceCategory.detailed);
  if (primary.startsWith('income') || detailed.startsWith('income')) return 'inflow';
  if (primary === 'transfer in' || detailed.startsWith('transfer in')) return 'inflow';
  if (primary === 'transfer out' || detailed.startsWith('transfer out')) return 'outflow';
  return null;
}

function normalizePlaidToken(value: unknown): string {
  return typeof value === 'string'
    ? value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    : '';
}

function mapAccountKind(type?: string, subtype?: string): 'checking' | 'savings' | 'credit' | 'other' {
  if (type === 'credit') return 'credit';
  if (subtype === 'checking') return 'checking';
  if (subtype === 'savings') return 'savings';
  return 'other';
}
