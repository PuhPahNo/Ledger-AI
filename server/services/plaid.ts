import { and, eq, inArray, sql } from 'drizzle-orm';
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
import { badRequest, notFound, serviceUnavailable } from '../lib/errors.js';
import { NonRetryableJobError, enqueue } from '../jobs/queue.js';
import { hasPendingPlaidSync } from '../jobs/scheduler.js';
import { resolveTransactionBusinessId } from './accountAssignment.js';
import {
  categorizeTransactionWithDetails,
  isExcludedFromSpendCategory,
  isProtectedCategorySource,
  shouldAutoApplyAiSuggestion,
} from './categorization.js';
import { createAiCategorySuggestionReview } from './categorizationFeedback.js';
import { applyTagRulesBestEffort } from './tagging.js';
import { getReceiptTrackingSince } from './appSettings.js';
import { receiptWaiverForNewTransaction } from './receiptWaivers.js';

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

/**
 * Update-mode Link: re-authenticates an existing Item in place (same access_token, same
 * item_id, same cursor), so no public-token exchange and no new connection row is needed.
 */
export async function createPlaidUpdateLinkToken(
  userId: string,
  connectionId: string,
): Promise<{ link_token: string; expiration: string }> {
  const client = plaidClient();
  if (!client) {
    serviceUnavailable('Plaid is not configured. Add PLAID_CLIENT_ID and PLAID_SECRET in Render, then redeploy.');
  }
  const connection = await db.query.connections.findFirst({ where: eq(connections.id, connectionId) });
  if (!connection || (connection.kind !== 'bank' && connection.kind !== 'card')) notFound('Plaid connection not found');
  if (!connection.encryptedAccessToken) {
    badRequest('This connection was disconnected. Add it again as a new Plaid connection.');
  }
  const env = getEnv();
  const res = await client.linkTokenCreate({
    user: { client_user_id: userId },
    client_name: 'Ledger AI',
    country_codes: [CountryCode.Us],
    language: 'en',
    webhook: env.PLAID_WEBHOOK_URL || undefined,
    access_token: decryptText(connection.encryptedAccessToken),
  });
  return res.data;
}

/**
 * Best-effort Plaid /item/remove so a disconnected Item stops being billed and the bank
 * consent is revoked. Never throws: a Plaid outage must not block the local disconnect.
 */
export async function removePlaidItem(encryptedAccessToken: string | null | undefined): Promise<boolean> {
  if (!encryptedAccessToken) return false;
  const client = plaidClient();
  if (!client) return false;
  try {
    await client.itemRemove({ access_token: decryptText(encryptedAccessToken) });
    return true;
  } catch (error) {
    const code = (error as { response?: { data?: { error_code?: unknown } } })?.response?.data?.error_code;
    console.warn(`Plaid itemRemove failed${typeof code === 'string' ? ` (${code})` : ''}; disconnecting locally anyway`);
    return false;
  }
}

export interface PlaidSyncResult {
  /** Transactions newly inserted this run. */
  added: number;
  /** Existing transactions Plaid modified or removed this run — amounts, dates, and receipt
   * links may have shifted, so unmatched receipts deserve another pass. */
  changed: number;
}

type PlaidRawTransaction = Record<string, any>;
type PlaidRawAccount = Record<string, any>;

export interface PlaidSyncPage {
  accounts?: PlaidRawAccount[];
  added?: PlaidRawTransaction[];
  modified?: PlaidRawTransaction[];
  removed?: Array<{ transaction_id?: string | null }>;
  next_cursor: string;
  has_more: boolean;
}

export interface PlaidSyncBatch {
  accounts: PlaidRawAccount[];
  added: PlaidRawTransaction[];
  modified: PlaidRawTransaction[];
  removed: string[];
  nextCursor: string | undefined;
}

export interface UnassignableAccountSummary {
  plaidAccountId: string;
  label: string;
  count: number;
}

/** Thrown when a batch contains transactions that no business can own. Retrying can't help
 * until someone assigns a business, so the job queue treats it as non-retryable. */
export class PlaidSyncBlockedError extends NonRetryableJobError {
  constructor(readonly unassignable: UnassignableAccountSummary[]) {
    super(plaidSyncBlockedMessage(unassignable));
    this.name = 'PlaidSyncBlockedError';
  }
}

export function plaidSyncBlockedMessage(unassignable: UnassignableAccountSummary[]): string {
  const total = unassignable.reduce((sum, item) => sum + item.count, 0);
  const labels = unassignable.map((item) => item.label).join(', ');
  return `Sync paused: ${total} transaction${total === 1 ? '' : 's'} on ${labels} ha${total === 1 ? 's' : 've'} no business. `
    + 'Assign a business to the account (or a default business on the connection) in Connections; '
    + 'nothing was skipped and they will import on the next sync.';
}

const MAX_PAGINATION_RESTARTS = 3;

/**
 * Plaid's recommended /transactions/sync pattern: page through everything first, and if the
 * Item changes mid-pagination restart from the cursor we started with. Nothing is written to
 * the database here, so a restart never leaves half-applied pages behind.
 */
export async function collectPlaidSyncPages(
  fetchPage: (cursor: string | undefined) => Promise<PlaidSyncPage>,
  startCursor: string | undefined,
  maxRestarts = MAX_PAGINATION_RESTARTS,
): Promise<PlaidSyncBatch> {
  for (let attempt = 0; ; attempt += 1) {
    const accountsById = new Map<string, PlaidRawAccount>();
    const batch: PlaidSyncBatch = { accounts: [], added: [], modified: [], removed: [], nextCursor: startCursor };
    let cursor = startCursor;
    let hasMore = true;
    try {
      while (hasMore) {
        const page = await fetchPage(cursor);
        for (const account of page.accounts ?? []) {
          if (account?.account_id) accountsById.set(String(account.account_id), account);
        }
        batch.added.push(...(page.added ?? []));
        batch.modified.push(...(page.modified ?? []));
        for (const removed of page.removed ?? []) {
          if (removed?.transaction_id) batch.removed.push(removed.transaction_id);
        }
        cursor = page.next_cursor;
        hasMore = page.has_more;
      }
    } catch (error) {
      if (plaidErrorCode(error) === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' && attempt < maxRestarts) continue;
      throw error;
    }
    batch.accounts = [...accountsById.values()];
    batch.nextCursor = cursor;
    return batch;
  }
}

export interface PlaidSyncSteps {
  fetchPage: (cursor: string | undefined) => Promise<PlaidSyncPage>;
  upsertAccounts: (accounts: PlaidRawAccount[]) => Promise<void>;
  /** Transactions (added/modified) no business could own, grouped by account. */
  findUnassignable: (txns: PlaidRawTransaction[]) => Promise<UnassignableAccountSummary[]>;
  markBlocked: (unassignable: UnassignableAccountSummary[]) => Promise<void>;
  applyAdded: (txn: PlaidRawTransaction) => Promise<boolean>;
  applyModified: (txn: PlaidRawTransaction) => Promise<void>;
  applyRemoved: (plaidTransactionId: string) => Promise<boolean>;
  commit: (nextCursor: string | undefined, addedCount: number) => Promise<void>;
}

/**
 * One sync run. Invariant: the cursor is saved only after every added/modified/removed entry
 * in the batch has been written, so a crash, a Plaid error, or an unassignable account makes
 * the next run re-read the same changes instead of silently dropping them.
 */
export async function runPlaidSync(startCursor: string | undefined, steps: PlaidSyncSteps): Promise<PlaidSyncResult> {
  const batch = await collectPlaidSyncPages(steps.fetchPage, startCursor);
  // Accounts first, even when blocked: unassigned accounts have to exist before the owner
  // can pick a business for them.
  await steps.upsertAccounts(batch.accounts);

  const unassignable = await steps.findUnassignable([...batch.added, ...batch.modified]);
  if (unassignable.length > 0) {
    await steps.markBlocked(unassignable);
    throw new PlaidSyncBlockedError(unassignable);
  }

  let added = 0;
  let changed = 0;
  // Added → modified → removed: a pending row's `removed` entry must never run before its
  // posted replacement in `added` has adopted the receipt, notes and category.
  for (const txn of batch.added) {
    if (await steps.applyAdded(txn)) added += 1;
  }
  for (const txn of batch.modified) {
    await steps.applyModified(txn);
    changed += 1;
  }
  for (const plaidTransactionId of batch.removed) {
    if (await steps.applyRemoved(plaidTransactionId)) changed += 1;
  }
  await steps.commit(batch.nextCursor, added);
  return { added, changed };
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
  // Only Plaid Items (bank/card) — never send a Gmail or QuickBooks token to Plaid.
  if (connection.kind !== 'bank' && connection.kind !== 'card') return { added: 0, changed: 0 };
  const accessToken = decryptText(connection.encryptedAccessToken);
  const connectionBusinessId = connection.businessId ?? undefined;
  const startCursor = options.resetCursor ? undefined : connection.plaidCursor ?? undefined;
  // Spend dated before this cutoff isn't expected to have a receipt (imported as 'waived').
  const receiptTrackingSince = await getReceiptTrackingSince();
  const upsertOptions = { allowAiCategorization: options.allowAiCategorization, receiptTrackingSince };

  return runPlaidSync(startCursor, {
    fetchPage: async (cursor) => {
      try {
        const res = await client.transactionsSync({
          access_token: accessToken,
          cursor,
          count: 500,
          options: options.daysRequested ? { days_requested: options.daysRequested } : undefined,
        });
        return res.data as unknown as PlaidSyncPage;
      } catch (error) {
        // Expired bank credentials would otherwise fail silently forever: flag the
        // connection so the scheduler skips it and the UI can prompt a re-link.
        if (isPlaidReauthError(error)) {
          await db.update(connections)
            .set({ status: 'reauth', updatedAt: new Date() })
            .where(and(eq(connections.id, connectionId), eq(connections.status, 'live')));
        }
        throw error;
      }
    },
    upsertAccounts: (plaidAccounts) => upsertAccounts(connectionId, connectionBusinessId, plaidAccounts),
    findUnassignable: (txns) => findUnassignablePlaidTransactions(connectionBusinessId, txns),
    markBlocked: async (unassignable) => {
      const blocked = {
        at: new Date().toISOString(),
        message: plaidSyncBlockedMessage(unassignable),
        accounts: unassignable,
      };
      await db.update(connections).set({
        metadata: sql`coalesce(${connections.metadata}, '{}'::jsonb) || jsonb_build_object('syncBlocked', ${JSON.stringify(blocked)}::jsonb)`,
        updatedAt: new Date(),
      }).where(eq(connections.id, connectionId));
    },
    applyAdded: (txn) => upsertTransaction(connectionId, connectionBusinessId, txn, upsertOptions),
    applyModified: async (txn) => {
      await upsertTransaction(connectionId, connectionBusinessId, txn, upsertOptions);
    },
    applyRemoved: (plaidTransactionId) => archiveRemovedPlaidTransaction(plaidTransactionId),
    commit: async (nextCursor, addedCount) => {
      await db.update(connections).set({
        plaidCursor: nextCursor,
        lastSyncAt: new Date(),
        syncedTransactionCount: sql`${connections.syncedTransactionCount} + ${addedCount}`,
        // A full successful sync proves the credentials work again (e.g. after update-mode
        // Link). Never resurrect a connection the owner disconnected.
        status: sql`CASE WHEN ${connections.status} = 'reauth' THEN 'live'::connection_status ELSE ${connections.status} END`,
        metadata: sql`coalesce(${connections.metadata}, '{}'::jsonb) - 'syncBlocked'`,
        updatedAt: new Date(),
      }).where(eq(connections.id, connectionId));
    },
  });
}

/**
 * After an owner assigns a business, retry a sync that was paused for lack of one right away
 * instead of waiting for the daily scheduler. No-op for connections that aren't blocked.
 */
export async function resumeBlockedPlaidSync(connectionId: string | null | undefined): Promise<string | null> {
  if (!connectionId) return null;
  const connection = await db.query.connections.findFirst({ where: eq(connections.id, connectionId) });
  if (!connection || (connection.kind !== 'bank' && connection.kind !== 'card') || connection.status === 'disconnected') return null;
  if (!connection.metadata?.syncBlocked) return null;
  if (await hasPendingPlaidSync(connectionId)) return null;
  return enqueue('plaid.sync', { connectionId });
}

/**
 * Which transactions would have no owning business: the account's business, else the
 * connection default, else (for rows we already stored) the row's current business.
 */
async function findUnassignablePlaidTransactions(
  connectionBusinessId: string | undefined,
  txns: PlaidRawTransaction[],
): Promise<UnassignableAccountSummary[]> {
  if (connectionBusinessId || txns.length === 0) return [];
  const plaidAccountIds = [...new Set(txns.map((txn) => String(txn.account_id ?? '')).filter(Boolean))];
  const accountRows = plaidAccountIds.length
    ? await db
      .select({ plaidAccountId: accounts.plaidAccountId, businessId: accounts.businessId, name: accounts.name, nickname: accounts.nickname, mask: accounts.mask })
      .from(accounts)
      .where(inArray(accounts.plaidAccountId, plaidAccountIds))
    : [];
  const accountById = new Map(accountRows.map((row) => [row.plaidAccountId, row]));
  const candidates = txns.filter((txn) => !resolveTransactionBusinessId(accountById.get(txn.account_id)?.businessId, undefined));
  if (candidates.length === 0) return [];

  const candidateIds = candidates.map((txn) => txn.transaction_id).filter((id): id is string => typeof id === 'string' && id.length > 0);
  const existingRows = candidateIds.length
    ? await db
      .select({ plaidTransactionId: transactions.plaidTransactionId })
      .from(transactions)
      .where(inArray(transactions.plaidTransactionId, candidateIds))
    : [];
  const existing = new Set(existingRows.map((row) => row.plaidTransactionId));

  const byAccount = new Map<string, UnassignableAccountSummary>();
  for (const txn of candidates) {
    if (txn.transaction_id && existing.has(txn.transaction_id)) continue;
    const plaidAccountId = String(txn.account_id ?? 'unknown');
    const account = accountById.get(plaidAccountId);
    const label = account
      ? `${account.nickname ?? account.name}${account.mask ? ` ••${account.mask}` : ''}`
      : 'an unknown account';
    const summary = byAccount.get(plaidAccountId) ?? { plaidAccountId, label, count: 0 };
    summary.count += 1;
    byAccount.set(plaidAccountId, summary);
  }
  return [...byAccount.values()];
}

const PLAID_REAUTH_ERROR_CODES = new Set([
  'ITEM_LOGIN_REQUIRED',
  'ITEM_LOCKED',
  'USER_PERMISSION_REVOKED',
  'ACCESS_NOT_GRANTED',
]);

function plaidErrorCode(error: unknown): string | null {
  const code = (error as { response?: { data?: { error_code?: unknown } } })?.response?.data?.error_code;
  return typeof code === 'string' ? code : null;
}

function isPlaidReauthError(error: unknown): boolean {
  const code = plaidErrorCode(error);
  return code != null && PLAID_REAUTH_ERROR_CODES.has(code);
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
  const existing = raw.transaction_id
    ? await db.query.transactions.findFirst({
      where: eq(transactions.plaidTransactionId, raw.transaction_id),
      columns: { id: true, businessId: true },
    })
    : null;
  const businessId = resolveTransactionBusinessId(account?.businessId, fallbackBusinessId) ?? existing?.businessId;
  if (!businessId) {
    // runPlaidSync checks assignability before writing anything, so this means a business was
    // unassigned mid-sync. Fail loudly: the cursor stays put and the next run retries.
    throw new Error(`Plaid transaction ${raw.transaction_id ?? '(no id)'} has no business to belong to; sync aborted before saving the cursor`);
  }
  const amountCents = plaidAmountCents(raw);
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
  const shouldReviewAi = categorization.source === 'ai_suggested' && !shouldAutoApplyAiSuggestion(categorization);
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
    { merchant: raw.merchant_name ?? raw.name ?? 'Unknown merchant', businessId },
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
      // Backfill the account link for rows stored before the account existed, but never
      // repoint it. businessId is deliberately NOT updated: users can move a single
      // transaction to another business (transaction PATCH / assistant actions) and nothing
      // records that override, so following the account here would silently undo it.
      // Re-assigning an account's history is the explicit "apply to existing" action.
      accountId: sql`coalesce(${transactions.accountId}, excluded.account_id)`,
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
    await applyTagRulesBestEffort(saved);
  }
  return !existing;
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
      // Release the pending row first: transactions.receipt_id is unique (migration 0022).
      await db
        .update(transactions)
        .set({ receiptId: null, updatedAt: new Date() })
        .where(eq(transactions.id, predecessor.id));
      await db
        .update(transactions)
        .set({ receiptId: receipt.id, receiptStatus: 'matched', updatedAt: new Date() })
        .where(eq(transactions.id, saved.id));
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
  subject?: { merchant: string; businessId: string },
): Promise<'missing' | 'n/a' | 'waived'> {
  if (amountCents >= 0) return 'n/a';
  if (categoryId) {
    const category = await db.query.categories.findFirst({ where: eq(categories.id, categoryId) });
    if (category && isExcludedFromSpendCategory(category)) return 'n/a';
  }
  // Spend that predates receipt tracking isn't expected to have a receipt.
  if (receiptTrackingSince && date && date < receiptTrackingSince) return 'waived';
  // "No receipt needed" rules (under-$X, merchant, category); evidence is recorded after sync.
  if (subject && await receiptWaiverForNewTransaction({ amountCents, categoryId, ...subject })) return 'waived';
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
