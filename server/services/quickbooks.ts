import { createHmac } from 'node:crypto';
import { and, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { signOAuthState, verifyOAuthState, type OAuthStateResult } from '../auth/oauthState.js';
import { getEnv } from '../config/env.js';
import { db } from '../db/client.js';
import {
  businesses,
  categories,
  connections,
  qboAccounts,
  qboAttachments,
  qboCompanies,
  qboTransactionLinks,
  qboTransactions,
  qboVendors,
  transactions,
  type QboTransaction,
  type QboTransactionLeg,
  type QboTransactionLine,
} from '../db/schema.js';
import { decryptText, encryptText } from '../lib/crypto.js';
import { badRequest, conflict, notFound, serviceUnavailable } from '../lib/errors.js';
import {
  QboApiClient,
  QboReauthRequiredError,
  accessTokenNeedsRefresh,
  ensureFreshAccessToken,
  exchangeAuthorizationCode,
  quickbooksAuthorizeUrl,
  quickbooksConfig,
  revokeQuickbooksToken,
  type FetchLike,
  type QboConfig,
  type QboTokenSet,
} from './quickbooksClient.js';
import { isContractLaborAccount } from './quickbooksContractors.js';
import { categoriesForBusiness, ledgerAccountsForBusiness, suggestCategory, suggestLedgerAccounts } from './quickbooksMapping.js';
import { isBankOrCardAccountType, isExpenseAccountType } from './quickbooksNormalize.js';

export function requireQuickbooksConfig(): QboConfig {
  const config = quickbooksConfig();
  if (!config) serviceUnavailable('QuickBooks is not configured on this server.');
  return config;
}

// ---------------------------------------------------------------------------------------------
// OAuth state (domain-separated from the Gmail flow by a derived secret)
// ---------------------------------------------------------------------------------------------

function qboStateSecret(): string {
  return createHmac('sha256', getEnv().SESSION_SECRET).update('ledger-ai:quickbooks-oauth-state:v1').digest('base64url');
}

export function signQuickbooksState(userId: string, businessId: string): string {
  return signOAuthState(qboStateSecret(), { userId, businessId });
}

export function verifyQuickbooksState(state: string, userId: string): OAuthStateResult {
  return verifyOAuthState(qboStateSecret(), state, userId);
}

// ---------------------------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------------------------

async function persistTokens(executor: Pick<typeof db, 'update'>, connectionId: string, tokens: QboTokenSet): Promise<void> {
  const now = new Date();
  await executor.update(connections).set({
    encryptedAccessToken: encryptText(tokens.accessToken),
    encryptedRefreshToken: encryptText(tokens.refreshToken),
    updatedAt: now,
  }).where(eq(connections.id, connectionId));
  await executor.update(qboCompanies).set({
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    ...(tokens.refreshTokenExpiresAt ? { refreshTokenExpiresAt: tokens.refreshTokenExpiresAt } : {}),
    lastTokenRefreshAt: now,
    updatedAt: now,
  }).where(eq(qboCompanies.connectionId, connectionId));
}

export async function markQuickbooksReauth(connectionId: string, reason: string): Promise<void> {
  await db.update(connections).set({ status: 'reauth', updatedAt: new Date() })
    .where(and(eq(connections.id, connectionId), ne(connections.status, 'disconnected')));
  await db.update(qboCompanies).set({ lastSyncError: reason, updatedAt: new Date() }).where(eq(qboCompanies.connectionId, connectionId));
}

/**
 * Fresh access token for a connection. The refresh runs under a row lock so two workers never
 * spend the same refresh token, and the rotated refresh token is persisted in that transaction.
 */
export async function quickbooksAccessToken(
  connectionId: string,
  options: { force?: boolean; fetchImpl?: FetchLike } = {},
): Promise<{ accessToken: string; expiresAt: Date }> {
  const config = requireQuickbooksConfig();
  let expiresAt = new Date(0);
  try {
    const accessToken = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(connections).where(eq(connections.id, connectionId)).for('update');
      const company = await tx.query.qboCompanies.findFirst({ where: eq(qboCompanies.connectionId, connectionId) });
      if (!row || row.kind !== 'quickbooks' || !company) throw new Error('QuickBooks connection not found');
      if (row.status === 'disconnected') throw new QboReauthRequiredError('QuickBooks connection is disconnected.');
      return ensureFreshAccessToken(config, {
        async load() {
          if (!row.encryptedAccessToken || !row.encryptedRefreshToken) throw new QboReauthRequiredError();
          const tokens: QboTokenSet = {
            accessToken: decryptText(row.encryptedAccessToken),
            refreshToken: decryptText(row.encryptedRefreshToken),
            accessTokenExpiresAt: company.accessTokenExpiresAt ?? new Date(0),
            refreshTokenExpiresAt: company.refreshTokenExpiresAt,
          };
          expiresAt = tokens.accessTokenExpiresAt;
          return tokens;
        },
        async persist(tokens) {
          expiresAt = tokens.accessTokenExpiresAt;
          await persistTokens(tx, connectionId, tokens);
        },
      }, { force: options.force, fetchImpl: options.fetchImpl });
    });
    return { accessToken, expiresAt };
  } catch (error) {
    if (error instanceof QboReauthRequiredError) await markQuickbooksReauth(connectionId, error.message);
    throw error;
  }
}

/** API client for a connection; caches the access token in memory until it nears expiry. */
export async function quickbooksApiClient(connectionId: string, options: { fetchImpl?: FetchLike } = {}): Promise<QboApiClient> {
  const config = requireQuickbooksConfig();
  const company = await db.query.qboCompanies.findFirst({ where: eq(qboCompanies.connectionId, connectionId) });
  if (!company) notFound('QuickBooks connection not found');
  let cached: { accessToken: string; expiresAt: Date } | null = null;
  return new QboApiClient({
    realmId: company.realmId,
    apiBase: config.apiBase,
    fetchImpl: options.fetchImpl,
    getAccessToken: async (force) => {
      if (!force && cached && !accessTokenNeedsRefresh({
        accessToken: cached.accessToken,
        refreshToken: '',
        accessTokenExpiresAt: cached.expiresAt,
        refreshTokenExpiresAt: null,
      }, new Date())) {
        return cached.accessToken;
      }
      cached = await quickbooksAccessToken(connectionId, { force, fetchImpl: options.fetchImpl });
      return cached.accessToken;
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Connect / disconnect
// ---------------------------------------------------------------------------------------------

export async function startQuickbooksConnect(userId: string, businessId: string): Promise<{ url: string }> {
  const config = requireQuickbooksConfig();
  const business = await db.query.businesses.findFirst({ where: eq(businesses.id, businessId) });
  if (!business) notFound('Business not found');
  const existing = await activeCompanyForBusiness(businessId);
  if (existing && existing.status === 'live') {
    conflict(`${business.name} is already connected to QuickBooks (${existing.companyName ?? existing.realmId}). Disconnect it first.`);
  }
  return { url: quickbooksAuthorizeUrl(config, signQuickbooksState(userId, businessId)) };
}

async function activeCompanyForBusiness(businessId: string) {
  const [row] = await db
    .select({
      connectionId: qboCompanies.connectionId,
      realmId: qboCompanies.realmId,
      companyName: qboCompanies.companyName,
      status: connections.status,
    })
    .from(qboCompanies)
    .innerJoin(connections, eq(qboCompanies.connectionId, connections.id))
    .where(and(eq(qboCompanies.businessId, businessId), eq(qboCompanies.active, true)))
    .limit(1);
  return row ?? null;
}

/**
 * OAuth callback: exchanges the code, reads CompanyInfo, and attaches the company to the
 * business from the signed state. Reconnecting the same realm reuses the old connection row
 * (mappings, links and history survive).
 */
export async function completeQuickbooksConnect(input: {
  code: string;
  realmId: string;
  businessId: string;
  fetchImpl?: FetchLike;
}): Promise<{ connectionId: string; created: boolean }> {
  const config = requireQuickbooksConfig();
  const business = await db.query.businesses.findFirst({ where: eq(businesses.id, input.businessId) });
  if (!business) notFound('Business not found');

  const tokens = await exchangeAuthorizationCode(config, input.code, input.fetchImpl ?? fetch);
  const probe = new QboApiClient({
    realmId: input.realmId,
    apiBase: config.apiBase,
    fetchImpl: input.fetchImpl,
    getAccessToken: async () => tokens.accessToken,
  });
  const info = await probe.companyInfo().catch(() => null);
  const companyName = typeof info?.CompanyName === 'string' && info.CompanyName.trim() ? info.CompanyName.trim() : `QuickBooks ${input.realmId}`;

  const realmElsewhere = await db
    .select({ businessId: qboCompanies.businessId, name: businesses.name })
    .from(qboCompanies)
    .innerJoin(businesses, eq(qboCompanies.businessId, businesses.id))
    .where(and(eq(qboCompanies.realmId, input.realmId), eq(qboCompanies.active, true), ne(qboCompanies.businessId, input.businessId)))
    .limit(1);
  if (realmElsewhere.length) {
    await revokeQuickbooksToken(config, tokens.refreshToken, input.fetchImpl ?? fetch);
    conflict(`That QuickBooks company is already connected to ${realmElsewhere[0].name}.`);
  }

  const current = await activeCompanyForBusiness(input.businessId);
  if (current && current.realmId !== input.realmId) {
    if (current.status === 'live') {
      await revokeQuickbooksToken(config, tokens.refreshToken, input.fetchImpl ?? fetch);
      conflict(`${business.name} is already connected to a different QuickBooks company. Disconnect it first.`);
    }
    // The old company needed re-consent and the admin picked a different one: retire it.
    await retireCompany(current.connectionId);
  }

  const [previous] = await db
    .select({ connectionId: qboCompanies.connectionId })
    .from(qboCompanies)
    .where(and(eq(qboCompanies.businessId, input.businessId), eq(qboCompanies.realmId, input.realmId)))
    .orderBy(desc(qboCompanies.updatedAt))
    .limit(1);

  const now = new Date();
  return db.transaction(async (tx) => {
    let connectionId: string;
    let created = false;
    if (previous) {
      connectionId = previous.connectionId;
      await tx.update(connections).set({
        status: 'live',
        label: companyName,
        businessId: input.businessId,
        providerItemId: input.realmId,
        updatedAt: now,
      }).where(eq(connections.id, connectionId));
      await tx.update(qboCompanies).set({ active: true, companyName, environment: config.environment, lastSyncError: null, updatedAt: now })
        .where(eq(qboCompanies.connectionId, connectionId));
    } else {
      const [row] = await tx.insert(connections).values({
        businessId: input.businessId,
        kind: 'quickbooks',
        label: companyName,
        status: 'live',
        providerItemId: input.realmId,
        metadata: { provider: 'quickbooks' },
      }).returning({ id: connections.id });
      connectionId = row.id;
      created = true;
      await tx.insert(qboCompanies).values({
        connectionId,
        businessId: input.businessId,
        realmId: input.realmId,
        companyName,
        environment: config.environment,
        active: true,
      });
    }
    await persistTokens(tx, connectionId, tokens);
    return { connectionId, created };
  });
}

async function retireCompany(connectionId: string): Promise<void> {
  await db.update(qboCompanies).set({ active: false, updatedAt: new Date() }).where(eq(qboCompanies.connectionId, connectionId));
  await db.update(connections).set({
    status: 'disconnected',
    encryptedAccessToken: null,
    encryptedRefreshToken: null,
    updatedAt: new Date(),
  }).where(eq(connections.id, connectionId));
}

/** Revokes the token at Intuit (best effort) and deactivates the company. Synced data is kept. */
export async function disconnectQuickbooks(connectionId: string, fetchImpl: FetchLike = fetch): Promise<{ revoked: boolean }> {
  const row = await db.query.connections.findFirst({ where: eq(connections.id, connectionId) });
  if (!row || row.kind !== 'quickbooks') notFound('QuickBooks connection not found');
  const config = quickbooksConfig();
  let revoked = false;
  const token = row.encryptedRefreshToken ?? row.encryptedAccessToken;
  if (config && token) {
    try {
      revoked = await revokeQuickbooksToken(config, decryptText(token), fetchImpl);
    } catch {
      revoked = false;
    }
  }
  await retireCompany(connectionId);
  return { revoked };
}

export async function requireQuickbooksConnection(connectionId: string) {
  const row = await db.query.connections.findFirst({ where: eq(connections.id, connectionId) });
  const company = await db.query.qboCompanies.findFirst({ where: eq(qboCompanies.connectionId, connectionId) });
  if (!row || row.kind !== 'quickbooks' || !company) notFound('QuickBooks connection not found');
  return { connection: row, company };
}

// ---------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------

export async function quickbooksStatus() {
  const config = quickbooksConfig();
  const businessRows = await db.select().from(businesses).where(eq(businesses.active, true)).orderBy(businesses.name);
  const companyRows = await db
    .select({ company: qboCompanies, connection: connections })
    .from(qboCompanies)
    .innerJoin(connections, eq(qboCompanies.connectionId, connections.id))
    .where(eq(qboCompanies.active, true));
  const connectionIds = companyRows.map((r) => r.company.connectionId);

  const counts = new Map<string, { accounts: number; vendors: number; transactions: number; linked: number; attachments: number; unmappedBankAccounts: number }>();
  if (connectionIds.length) {
    const rows = await db.execute(sql`
      SELECT c.connection_id::text AS connection_id,
        (SELECT count(*)::int FROM qbo_accounts a WHERE a.connection_id = c.connection_id AND NOT a.deleted) AS accounts,
        (SELECT count(*)::int FROM qbo_accounts a WHERE a.connection_id = c.connection_id AND NOT a.deleted AND a.active
           AND a.account_type IN ('Bank', 'Credit Card') AND a.ledger_account_id IS NULL) AS unmapped_bank_accounts,
        (SELECT count(*)::int FROM qbo_vendors v WHERE v.connection_id = c.connection_id AND NOT v.deleted) AS vendors,
        (SELECT count(*)::int FROM qbo_transactions t WHERE t.connection_id = c.connection_id AND NOT t.deleted) AS transactions,
        (SELECT count(*)::int FROM qbo_transaction_links l JOIN qbo_transactions t ON t.id = l.qbo_transaction_id
           WHERE t.connection_id = c.connection_id AND l.status = 'linked') AS linked,
        (SELECT count(*)::int FROM qbo_attachments x WHERE x.connection_id = c.connection_id AND NOT x.deleted) AS attachments
      FROM qbo_companies c WHERE c.connection_id IN (${sql.join(connectionIds.map((id) => sql`${id}::uuid`), sql`, `)})
    `);
    for (const r of rows.rows as Array<Record<string, unknown>>) {
      counts.set(String(r.connection_id), {
        accounts: Number(r.accounts ?? 0),
        vendors: Number(r.vendors ?? 0),
        transactions: Number(r.transactions ?? 0),
        linked: Number(r.linked ?? 0),
        attachments: Number(r.attachments ?? 0),
        unmappedBankAccounts: Number(r.unmapped_bank_accounts ?? 0),
      });
    }
  }
  const syncingRows = connectionIds.length
    ? await db.execute(sql`
      SELECT payload->>'connectionId' AS connection_id FROM jobs
      WHERE type = 'quickbooks.sync' AND status IN ('queued', 'running') AND attempts < max_attempts
        AND payload->>'connectionId' IN (${sql.join(connectionIds.map((id) => sql`${id}`), sql`, `)})`)
    : { rows: [] };
  const syncing = new Set((syncingRows.rows as Array<Record<string, unknown>>).map((r) => String(r.connection_id)));

  return {
    configured: Boolean(config),
    environment: config?.environment ?? null,
    businesses: businessRows.map((business) => {
      const match = companyRows.find((r) => r.company.businessId === business.id);
      return {
        businessId: business.id,
        businessKey: business.key,
        businessName: business.name,
        connection: match ? {
          id: match.connection.id,
          status: match.connection.status,
          companyName: match.company.companyName,
          realmId: match.company.realmId,
          environment: match.company.environment,
          lastSyncAt: match.connection.lastSyncAt?.toISOString() ?? null,
          lastFullSyncAt: match.company.lastFullSyncAt?.toISOString() ?? null,
          lastSyncError: match.company.lastSyncError,
          historyStartDate: match.company.historyStartDate,
          syncing: syncing.has(match.connection.id),
          counts: counts.get(match.connection.id) ?? { accounts: 0, vendors: 0, transactions: 0, linked: 0, attachments: 0, unmappedBankAccounts: 0 },
        } : null,
      };
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Mappings
// ---------------------------------------------------------------------------------------------

export async function getQuickbooksMappings(connectionId: string) {
  const { company } = await requireQuickbooksConnection(connectionId);
  const rows = await db.select().from(qboAccounts)
    .where(and(eq(qboAccounts.connectionId, connectionId), eq(qboAccounts.deleted, false)))
    .orderBy(qboAccounts.accountType, qboAccounts.name);
  const ledgerAccounts = await ledgerAccountsForBusiness(company.businessId);
  const categoryOptions = await categoriesForBusiness(company.businessId);
  const categoryName = new Map(categoryOptions.map((c) => [c.id, c.name]));

  return {
    connectionId,
    businessId: company.businessId,
    bankAccounts: rows.filter((r) => isBankOrCardAccountType(r.accountType)).map((r) => ({
      qboAccount: apiQboAccount(r),
      ledgerAccountId: r.ledgerAccountId,
      method: r.ledgerAccountMethod,
      suggestions: suggestLedgerAccounts(r, ledgerAccounts).map((a) => ({ ledgerAccountId: a.id, name: a.nickname || a.name, mask: a.mask, reason: 'last4' as const })),
    })),
    expenseAccounts: rows.filter((r) => isExpenseAccountType(r.accountType)).map((r) => {
      const suggestion = suggestCategory(r, categoryOptions);
      return {
        qboAccount: apiQboAccount(r),
        categoryId: r.ledgerCategoryId,
        categoryName: r.ledgerCategoryId ? categoryName.get(r.ledgerCategoryId) ?? null : null,
        method: r.ledgerCategoryMethod,
        score: r.ledgerCategoryScore == null ? null : Number(r.ledgerCategoryScore),
        suggestion: suggestion ? { categoryId: suggestion.categoryId, name: suggestion.name, score: Number(suggestion.score.toFixed(4)) } : null,
        contractLabor: isContractLaborAccount({ name: r.name, mappedCategoryName: r.ledgerCategoryId ? categoryName.get(r.ledgerCategoryId) : null }),
      };
    }),
    ledgerAccounts: ledgerAccounts.map((a) => ({ id: a.id, name: a.nickname || a.name, mask: a.mask, kind: a.kind })),
    categories: categoryOptions,
  };
}

function apiQboAccount(row: typeof qboAccounts.$inferSelect) {
  return {
    id: row.id,
    qboId: row.qboId,
    name: row.name,
    fullyQualifiedName: row.fullyQualifiedName,
    accountType: row.accountType,
    accountSubType: row.accountSubType,
    acctNumLast4: row.acctNumLast4,
    active: row.active,
  };
}

export async function updateQuickbooksMappings(connectionId: string, input: {
  bankAccounts?: Array<{ qboAccountId: string; ledgerAccountId: string | null }>;
  expenseAccounts?: Array<{ qboAccountId: string; categoryId: string | null }>;
}): Promise<{ bankAccounts: number; expenseAccounts: number }> {
  const { company } = await requireQuickbooksConnection(connectionId);
  const ledgerAccounts = new Set((await ledgerAccountsForBusiness(company.businessId)).map((a) => a.id));
  const categoryIds = new Set((await categoriesForBusiness(company.businessId)).map((c) => c.id));
  const ids = [...(input.bankAccounts ?? []).map((m) => m.qboAccountId), ...(input.expenseAccounts ?? []).map((m) => m.qboAccountId)];
  const rows = ids.length
    ? await db.select().from(qboAccounts).where(and(eq(qboAccounts.connectionId, connectionId), inArray(qboAccounts.id, ids)))
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const now = new Date();

  for (const mapping of input.bankAccounts ?? []) {
    const row = byId.get(mapping.qboAccountId);
    if (!row || !isBankOrCardAccountType(row.accountType)) badRequest(`Unknown QuickBooks bank/card account ${mapping.qboAccountId}`);
    if (mapping.ledgerAccountId && !ledgerAccounts.has(mapping.ledgerAccountId)) badRequest('Ledger account must belong to the same business');
  }
  for (const mapping of input.expenseAccounts ?? []) {
    const row = byId.get(mapping.qboAccountId);
    if (!row || !isExpenseAccountType(row.accountType)) badRequest(`Unknown QuickBooks expense account ${mapping.qboAccountId}`);
    if (mapping.categoryId && !categoryIds.has(mapping.categoryId)) badRequest('Unknown category');
  }

  await db.transaction(async (tx) => {
    for (const mapping of input.bankAccounts ?? []) {
      // One Ledger account ↔ one QBO account: release any other QBO account holding it.
      if (mapping.ledgerAccountId) {
        await tx.update(qboAccounts).set({ ledgerAccountId: null, ledgerAccountMethod: null, updatedAt: now })
          .where(and(eq(qboAccounts.connectionId, connectionId), eq(qboAccounts.ledgerAccountId, mapping.ledgerAccountId), ne(qboAccounts.id, mapping.qboAccountId)));
      }
      // 'manual' with a null account = "explicitly not mapped"; auto-mapping won't refill it.
      await tx.update(qboAccounts).set({ ledgerAccountId: mapping.ledgerAccountId, ledgerAccountMethod: 'manual', updatedAt: now })
        .where(eq(qboAccounts.id, mapping.qboAccountId));
    }
    for (const mapping of input.expenseAccounts ?? []) {
      await tx.update(qboAccounts).set({ ledgerCategoryId: mapping.categoryId, ledgerCategoryMethod: 'manual', ledgerCategoryScore: null, updatedAt: now })
        .where(eq(qboAccounts.id, mapping.qboAccountId));
    }
  });
  return { bankAccounts: input.bankAccounts?.length ?? 0, expenseAccounts: input.expenseAccounts?.length ?? 0 };
}

// ---------------------------------------------------------------------------------------------
// Category signal (QBO expense account → Ledger category)
// ---------------------------------------------------------------------------------------------

export interface QuickbooksCategorySuggestion {
  transactionId: string;
  categoryId: string;
  source: 'quickbooks';
  confidence: number;
  evidence: {
    qboAccount: { qboId: string; name: string };
    vendor: { qboId: string; name: string } | null;
    qboTransactionId: string;
    entityType: string;
    mappingMethod: 'auto' | 'manual' | null;
    lineShare: number;
  };
}

export interface CategoryMappingLite {
  qboId: string;
  name: string;
  categoryId: string | null;
  method: 'auto' | 'manual' | null;
  score: number | null;
}

/**
 * Pure: pick the category that carries most of the transaction's expense lines. Confidence =
 * mapping strength (manual 0.9, auto 0.85 × name score) × share of the amount on that category.
 */
export function computeCategorySuggestion(
  transactionId: string,
  qbo: { id: string; entityType: string; vendorQboId: string | null; payeeName: string | null },
  lines: QboTransactionLine[],
  mappings: Map<string, CategoryMappingLite>,
): QuickbooksCategorySuggestion | null {
  const total = lines.reduce((sum, line) => sum + Math.abs(line.amountCents), 0);
  if (!total) return null;
  const byCategory = new Map<string, { cents: number; mapping: CategoryMappingLite }>();
  for (const line of lines) {
    const mapping = line.accountQboId ? mappings.get(line.accountQboId) : undefined;
    if (!mapping?.categoryId) continue;
    const entry = byCategory.get(mapping.categoryId) ?? { cents: 0, mapping };
    entry.cents += Math.abs(line.amountCents);
    // Prefer the strongest mapping as the evidence account.
    if (mapping.method === 'manual' && entry.mapping.method !== 'manual') entry.mapping = mapping;
    byCategory.set(mapping.categoryId, entry);
  }
  const best = Array.from(byCategory.entries()).sort((a, b) => b[1].cents - a[1].cents)[0];
  if (!best) return null;
  const [categoryId, { cents, mapping }] = best;
  const share = cents / total;
  if (share < 0.6) return null;
  const strength = mapping.method === 'manual' ? 0.9 : 0.85 * Math.min(1, mapping.score ?? 0.6);
  const confidence = Number((strength * share).toFixed(4));
  if (confidence < 0.5) return null;
  return {
    transactionId,
    categoryId,
    source: 'quickbooks',
    confidence,
    evidence: {
      qboAccount: { qboId: mapping.qboId, name: mapping.name },
      vendor: qbo.vendorQboId ? { qboId: qbo.vendorQboId, name: qbo.payeeName ?? '' } : null,
      qboTransactionId: qbo.id,
      entityType: qbo.entityType,
      mappingMethod: mapping.method,
      lineShare: Number(share.toFixed(4)),
    },
  };
}

/** Expense lines for a QBO transaction; bill payments use the lines of the bills they pay. */
async function expenseLinesFor(qbo: QboTransaction): Promise<QboTransactionLine[]> {
  if (qbo.entityType !== 'BillPayment') return qbo.lines;
  const billIds = qbo.linkedTxns.filter((l) => l.txnType === 'Bill').map((l) => l.txnId);
  if (!billIds.length) return [];
  const bills = await db.select({ lines: qboTransactions.lines }).from(qboTransactions)
    .where(and(eq(qboTransactions.connectionId, qbo.connectionId), eq(qboTransactions.entityType, 'Bill'), inArray(qboTransactions.qboId, billIds)));
  return bills.flatMap((b) => b.lines);
}

async function categoryMappings(connectionId: string): Promise<Map<string, CategoryMappingLite>> {
  const rows = await db.select().from(qboAccounts).where(eq(qboAccounts.connectionId, connectionId));
  return new Map(rows.map((r) => [r.qboId, {
    qboId: r.qboId,
    name: r.name,
    categoryId: r.ledgerCategoryId,
    method: r.ledgerCategoryMethod,
    score: r.ledgerCategoryScore == null ? null : Number(r.ledgerCategoryScore),
  }]));
}

/**
 * The ONE entry point for "what category does QuickBooks imply for this Ledger transaction?".
 * Returns null when the transaction isn't linked or its QBO accounts aren't mapped.
 */
export async function quickbooksCategorySuggestion(transactionId: string): Promise<QuickbooksCategorySuggestion | null> {
  const [link] = await db
    .select({ qbo: qboTransactions })
    .from(qboTransactionLinks)
    .innerJoin(qboTransactions, eq(qboTransactionLinks.qboTransactionId, qboTransactions.id))
    .where(and(eq(qboTransactionLinks.transactionId, transactionId), eq(qboTransactionLinks.status, 'linked'), eq(qboTransactions.deleted, false)))
    .limit(1);
  if (!link) return null;
  const qbo = link.qbo;
  if (qbo.entityType === 'Transfer' || qbo.entityType === 'Deposit') return null;
  return computeCategorySuggestion(transactionId, qbo, await expenseLinesFor(qbo), await categoryMappings(qbo.connectionId));
}

/**
 * Called after new links are created. Produces the category suggestions for the automation
 * layer. Returns the suggestions so callers/tests can inspect them.
 */
export async function emitQuickbooksCategorySignals(transactionIds: string[]): Promise<QuickbooksCategorySuggestion[]> {
  const out: QuickbooksCategorySuggestion[] = [];
  for (const transactionId of transactionIds) {
    const suggestion = await quickbooksCategorySuggestion(transactionId);
    if (!suggestion) continue;
    out.push(suggestion);
    // TODO(automation-merge): hand the suggestion to the categorization learning loop once the
    // automation agent's hook lands, e.g.
    //   await recordExternalCategorySignal({
    //     transactionId: suggestion.transactionId,
    //     categoryId: suggestion.categoryId,
    //     source: 'quickbooks',
    //     confidence: suggestion.confidence,
    //     evidence: suggestion.evidence,
    //   });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Links (manual) and transaction drawer details
// ---------------------------------------------------------------------------------------------

async function ledgerAccountForLeg(connectionId: string, leg: QboTransactionLeg): Promise<string | null> {
  const row = await db.query.qboAccounts.findFirst({
    where: and(eq(qboAccounts.connectionId, connectionId), eq(qboAccounts.qboId, leg.accountQboId)),
  });
  return row?.ledgerAccountId ?? null;
}

export async function linkQuickbooksTransaction(input: {
  transactionId: string;
  qboTransactionId: string;
  leg?: QboTransactionLeg['leg'];
  userId: string;
}): Promise<{ linkId: string }> {
  const txn = await db.query.transactions.findFirst({ where: eq(transactions.id, input.transactionId) });
  if (!txn) notFound('Transaction not found');
  const qbo = await db.query.qboTransactions.findFirst({ where: eq(qboTransactions.id, input.qboTransactionId) });
  if (!qbo || qbo.deleted) notFound('QuickBooks transaction not found');
  if (qbo.businessId !== txn.businessId) badRequest('The QuickBooks transaction belongs to a different business');

  let leg = input.leg;
  if (!leg) {
    for (const candidate of qbo.legs) {
      if (txn.accountId && await ledgerAccountForLeg(qbo.connectionId, candidate) === txn.accountId) {
        leg = candidate.leg;
        break;
      }
    }
    leg = leg ?? qbo.legs.find((l) => Math.sign(l.amountCents) === Math.sign(txn.amountCents))?.leg ?? qbo.legs[0]?.leg ?? 'main';
  } else if (qbo.legs.length && !qbo.legs.some((l) => l.leg === leg)) {
    badRequest(`This QuickBooks transaction has no '${leg}' side`);
  }

  const now = new Date();
  const linkId = await db.transaction(async (tx) => {
    // Replace whatever this Ledger transaction or QBO leg was linked to.
    await tx.update(qboTransactionLinks).set({ status: 'rejected', method: 'manual', updatedAt: now })
      .where(and(
        eq(qboTransactionLinks.status, 'linked'),
        or(
          eq(qboTransactionLinks.transactionId, input.transactionId),
          and(eq(qboTransactionLinks.qboTransactionId, qbo.id), eq(qboTransactionLinks.leg, leg!)),
        ),
      ));
    const [row] = await tx.insert(qboTransactionLinks).values({
      qboTransactionId: qbo.id,
      leg: leg!,
      transactionId: input.transactionId,
      method: 'manual',
      status: 'linked',
      confidence: '1.0000',
      reasons: { manual: true },
      createdByUserId: input.userId,
    }).onConflictDoUpdate({
      target: [qboTransactionLinks.qboTransactionId, qboTransactionLinks.leg, qboTransactionLinks.transactionId],
      set: { status: 'linked', method: 'manual', confidence: '1.0000', createdByUserId: input.userId, updatedAt: now },
    }).returning({ id: qboTransactionLinks.id });
    return row.id;
  });
  return { linkId };
}

/** Unlink: kept as 'rejected' so auto-linking never re-creates the pair. */
export async function unlinkQuickbooksTransaction(linkId: string): Promise<{ transactionId: string; qboTransactionId: string }> {
  const [row] = await db.update(qboTransactionLinks)
    .set({ status: 'rejected', method: 'manual', updatedAt: new Date() })
    .where(eq(qboTransactionLinks.id, linkId))
    .returning({ transactionId: qboTransactionLinks.transactionId, qboTransactionId: qboTransactionLinks.qboTransactionId });
  if (!row) notFound('Link not found');
  return row;
}

function apiQboTransaction(row: QboTransaction) {
  return {
    id: row.id,
    connectionId: row.connectionId,
    entityType: row.entityType,
    qboId: row.qboId,
    txnDate: row.txnDate,
    totalCents: row.totalCents,
    paymentMethod: row.paymentMethod,
    docNumber: row.docNumber,
    memo: row.memo,
    payeeName: row.payeeName,
    vendorQboId: row.vendorQboId,
    bankAccountName: row.bankAccountName,
    legs: row.legs,
    deleted: row.deleted,
  };
}

/** Everything the transaction drawer shows about QuickBooks for one Ledger transaction. */
export async function transactionQuickbooksDetails(transactionId: string) {
  const txn = await db.query.transactions.findFirst({ where: eq(transactions.id, transactionId) });
  if (!txn) notFound('Transaction not found');

  const linkRows = await db
    .select({ link: qboTransactionLinks, qbo: qboTransactions })
    .from(qboTransactionLinks)
    .innerJoin(qboTransactions, eq(qboTransactionLinks.qboTransactionId, qboTransactions.id))
    .where(and(eq(qboTransactionLinks.transactionId, transactionId), eq(qboTransactionLinks.status, 'linked')));

  const links = [];
  for (const { link, qbo } of linkRows) {
    const vendor = qbo.vendorQboId
      ? await db.query.qboVendors.findFirst({ where: and(eq(qboVendors.connectionId, qbo.connectionId), eq(qboVendors.qboId, qbo.vendorQboId)) })
      : undefined;
    const lines = await expenseLinesFor(qbo);
    const accountIds = Array.from(new Set(lines.map((l) => l.accountQboId).filter((id): id is string => Boolean(id))));
    const accountRows = accountIds.length
      ? await db
        .select({ qboId: qboAccounts.qboId, name: qboAccounts.name, categoryId: qboAccounts.ledgerCategoryId, categoryName: categories.name })
        .from(qboAccounts)
        .leftJoin(categories, eq(qboAccounts.ledgerCategoryId, categories.id))
        .where(and(eq(qboAccounts.connectionId, qbo.connectionId), inArray(qboAccounts.qboId, accountIds)))
      : [];
    const accountByQbo = new Map(accountRows.map((a) => [a.qboId, a]));
    const attachments = await db.select().from(qboAttachments)
      .where(and(eq(qboAttachments.qboTransactionId, qbo.id), eq(qboAttachments.deleted, false)));
    const contractLabor = accountRows.some((a) => isContractLaborAccount({ name: a.name, mappedCategoryName: a.categoryName }));
    links.push({
      linkId: link.id,
      leg: link.leg,
      method: link.method,
      confidence: link.confidence == null ? null : Number(link.confidence),
      reasons: link.reasons,
      qboTransaction: apiQboTransaction(qbo),
      vendor: vendor ? { qboId: vendor.qboId, name: vendor.displayName, vendor1099: vendor.vendor1099, taxIdOnFile: vendor.hasTaxId } : null,
      expenseAccounts: lines.map((l) => {
        const account = l.accountQboId ? accountByQbo.get(l.accountQboId) : undefined;
        return {
          qboAccountId: l.accountQboId,
          name: account?.name ?? l.accountName,
          amountCents: l.amountCents,
          description: l.description,
          categoryId: account?.categoryId ?? null,
          categoryName: account?.categoryName ?? null,
        };
      }),
      attachments: attachments.map((a) => ({
        id: a.id,
        fileName: a.fileName,
        contentType: a.contentType,
        importStatus: a.importStatus,
        receiptId: a.receiptId,
      })),
      isContractor: Boolean(vendor?.vendor1099) || contractLabor,
    });
  }

  return {
    transactionId,
    links,
    categorySuggestion: await quickbooksCategorySuggestion(transactionId),
    candidates: links.length ? [] : await manualLinkCandidates(txn),
  };
}

/** Unlinked QBO transactions on the same mapped account with the same amount, ±10 days. */
async function manualLinkCandidates(txn: typeof transactions.$inferSelect) {
  if (!txn.accountId) return [];
  const mapped = await db
    .select({ connectionId: qboAccounts.connectionId, qboId: qboAccounts.qboId })
    .from(qboAccounts)
    .where(eq(qboAccounts.ledgerAccountId, txn.accountId));
  if (!mapped.length) return [];
  const rows = await db.execute(sql`
    SELECT t.id FROM qbo_transactions t
    WHERE t.business_id = ${txn.businessId}::uuid AND NOT t.deleted
      AND t.connection_id IN (${sql.join(mapped.map((m) => sql`${m.connectionId}::uuid`), sql`, `)})
      AND t.txn_date BETWEEN (${txn.date}::date - 10) AND (${txn.date}::date + 10)
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(t.legs) lg
        WHERE lg->>'accountQboId' IN (${sql.join(mapped.map((m) => sql`${m.qboId}`), sql`, `)})
          AND (lg->>'amountCents')::bigint = ${txn.amountCents}
          AND NOT EXISTS (SELECT 1 FROM qbo_transaction_links l
            WHERE l.qbo_transaction_id = t.id AND l.leg = lg->>'leg' AND l.status = 'linked')
      )
    ORDER BY abs(t.txn_date - ${txn.date}::date)
    LIMIT 10`);
  const ids = (rows.rows as Array<{ id: string }>).map((r) => r.id);
  if (!ids.length) return [];
  const qboRows = await db.select().from(qboTransactions).where(inArray(qboTransactions.id, ids));
  return qboRows.map(apiQboTransaction);
}
