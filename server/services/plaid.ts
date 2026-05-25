import { eq, sql } from 'drizzle-orm';
import {
  Configuration,
  CountryCode,
  PlaidApi,
  PlaidEnvironments,
  Products,
} from 'plaid';
import { getEnv } from '../config/env.js';
import { db } from '../db/client.js';
import { accounts, categories, connections, transactions } from '../db/schema.js';
import { decryptText, encryptText } from '../lib/crypto.js';
import { serviceUnavailable } from '../lib/errors.js';
import { resolveTransactionBusinessId } from './accountAssignment.js';
import { categorizeTransactionWithDetails, isExcludedFromSpendCategory } from './categorization.js';
import { createAiCategorySuggestionReview } from './categorizationFeedback.js';

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

export async function syncPlaidConnection(
  connectionId: string,
  options: { resetCursor?: boolean; daysRequested?: number } = {},
): Promise<number> {
  const client = plaidClient();
  if (!client) return 0;
  const connection = await db.query.connections.findFirst({ where: eq(connections.id, connectionId) });
  if (!connection?.encryptedAccessToken) return 0;
  const accessToken = decryptText(connection.encryptedAccessToken);

  let cursor: string | undefined = options.resetCursor ? undefined : connection.plaidCursor ?? undefined;
  let addedCount = 0;
  let hasMore = true;

  while (hasMore) {
    const res = await client.transactionsSync({
      access_token: accessToken,
      cursor,
      count: 500,
      options: options.daysRequested ? { days_requested: options.daysRequested } : undefined,
    });
    const data = res.data;
    await upsertAccounts(connectionId, connection.businessId ?? undefined, data.accounts ?? []);
    for (const txn of data.added ?? []) {
      await upsertTransaction(connectionId, connection.businessId ?? undefined, txn);
      addedCount += 1;
    }
    for (const txn of data.modified ?? []) {
      await upsertTransaction(connectionId, connection.businessId ?? undefined, txn);
    }
    for (const removed of data.removed ?? []) {
      await db.delete(transactions).where(eq(transactions.plaidTransactionId, removed.transaction_id));
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

  return addedCount;
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

async function upsertTransaction(connectionId: string, fallbackBusinessId: string | undefined, raw: Record<string, any>): Promise<void> {
  const account = await db.query.accounts.findFirst({ where: eq(accounts.plaidAccountId, raw.account_id) });
  const businessId = resolveTransactionBusinessId(account?.businessId, fallbackBusinessId);
  if (!businessId) return;
  const amountCents = plaidAmountCents(raw);
  const categorization = await categorizeTransactionWithDetails({
    businessId,
    merchant: raw.merchant_name ?? raw.name ?? 'Unknown merchant',
    amountCents,
    plaidCategory: plaidCategoryHints(raw),
  });
  const shouldReviewAi = categorization.source === 'ai_suggested' && (categorization.confidence ?? 0) < 0.85;
  const uncategorizedCategoryId = shouldReviewAi ? await fallbackUncategorizedCategoryId() : null;
  const appliedCategoryId = shouldReviewAi ? uncategorizedCategoryId : categorization.categoryId;
  const appliedCategorySource = shouldReviewAi ? 'uncategorized' : categorization.source;
  const appliedCategoryConfidence = shouldReviewAi ? null : categorization.confidence;
  const appliedCategoryEvidence = shouldReviewAi
    ? { reason: 'ai_suggestion_deferred_to_review', suggestion: categorization }
    : categorization.evidence;
  const receiptStatus = await receiptStatusForPlaidTransaction(amountCents, appliedCategoryId);
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
}

async function receiptStatusForPlaidTransaction(amountCents: number, categoryId: string | null): Promise<'missing' | 'n/a'> {
  if (amountCents >= 0) return 'n/a';
  if (!categoryId) return 'missing';
  const category = await db.query.categories.findFirst({ where: eq(categories.id, categoryId) });
  return category && isExcludedFromSpendCategory(category) ? 'n/a' : 'missing';
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
