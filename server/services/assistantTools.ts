import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { and, asc, desc, eq, getTableColumns, gte, ilike, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { AuthedUser } from '../auth/session.js';
import { db } from '../db/client.js';
import { accounts, businesses, categories, categoryRules, connections, receipts, transactions } from '../db/schema.js';
import { audit } from './audit.js';
import {
  ASSISTANT_MUTATION_LIMIT,
  DEFAULT_TRANSACTION_DETAIL_LIMIT,
  EXPANDED_TRANSACTION_DETAIL_LIMIT,
  type AssistantReceiptUpdatePayload,
  needsExpandedDataApproval,
  requestedTransactionLimit,
  signAssistantToken,
  verifyAssistantToken,
} from './assistantSecurity.js';
import type { AssistantApprovalRequest, AssistantArtifact } from './assistantSchemas.js';
import { attachReceipt } from './matching.js';

type Direction = 'all' | 'inflow' | 'outflow' | 'operating-outflow' | 'transfer';
type SortKey = 'date' | 'amount' | 'largest' | 'merchant' | 'business' | 'category' | 'account';

export interface AssistantToolContext {
  user: AuthedUser;
  request?: FastifyRequest;
  expandedDataApproved?: boolean;
}

export interface AssistantToolResult {
  ok: boolean;
  message: string;
  data?: unknown;
  artifacts?: AssistantArtifact[];
  approvalRequests?: AssistantApprovalRequest[];
}

export interface ConfirmAssistantActionResult {
  ok: boolean;
  message: string;
  artifact?: AssistantArtifact;
}

const emptyToNull = z.string().nullable().optional().transform((value) => value === '' ? null : value);

const transactionFilterSchema = z.object({
  business: emptyToNull.describe('Business key/id/name, or null for all businesses.'),
  from: emptyToNull.describe('YYYY-MM-DD inclusive start date.'),
  to: emptyToNull.describe('YYYY-MM-DD inclusive end date.'),
  q: emptyToNull.describe('Merchant/category/account/note search text.'),
  accountIds: z.array(z.string()).default([]),
  categories: z.array(z.string()).default([]),
  receipts: z.array(z.enum(['matched', 'pending', 'missing', 'n/a', 'waived'])).default([]),
  direction: z.enum(['all', 'inflow', 'outflow', 'operating-outflow', 'transfer']).default('all'),
});

const queryTransactionsSchema = transactionFilterSchema.extend({
  limit: z.number().int().min(1).max(EXPANDED_TRANSACTION_DETAIL_LIMIT).default(DEFAULT_TRANSACTION_DETAIL_LIMIT),
  sort: z.enum(['date', 'amount', 'largest', 'merchant', 'business', 'category', 'account']).default('date'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});

const cashFlowSchema = z.object({
  business: emptyToNull,
  accountIds: z.array(z.string()).default([]),
  from: emptyToNull,
  to: emptyToNull,
  group: z.enum(['month', 'year']).default('month'),
  includeTransfers: z.boolean().default(false),
});

const ownerInsightsSchema = z.object({
  business: emptyToNull,
  accountIds: z.array(z.string()).default([]),
  from: emptyToNull,
  to: emptyToNull,
});

const transactionUpdateSchema = z.object({
  transactionId: z.string().uuid(),
  categoryId: z.string().uuid().nullable().optional(),
  categoryName: z.string().nullable().optional(),
  businessId: z.string().uuid().nullable().optional(),
  business: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
});

const bulkTransactionUpdateSchema = z.object({
  transactionIds: z.array(z.string().uuid()).min(1).max(ASSISTANT_MUTATION_LIMIT),
  categoryId: z.string().uuid().nullable().optional(),
  categoryName: z.string().nullable().optional(),
  businessId: z.string().uuid().nullable().optional(),
  business: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
});

const categoryRuleSchema = z.object({
  businessId: z.string().uuid().nullable().optional(),
  business: z.string().nullable().optional(),
  categoryId: z.string().uuid(),
  matchKind: z.enum(['merchant_exact', 'merchant_contains', 'plaid_category', 'amount_range']).default('merchant_contains'),
  pattern: z.string().min(1),
  priority: z.number().int().min(1).max(999).default(10),
});

const receiptStatusFilterSchema = z.enum(['matched', 'pending', 'missing', 'n/a', 'all']);

const queryReceiptsSchema = z.object({
  business: emptyToNull.describe('Business key/id/name, or null for all businesses.'),
  status: receiptStatusFilterSchema.nullable().default('pending'),
  source: z.enum(['upload', 'gmail', 'all']).nullable().default('all'),
  unmatched: z.boolean().default(true),
  q: emptyToNull.describe('Merchant, file name, or business search text.'),
  from: emptyToNull.describe('Receipt date YYYY-MM-DD inclusive start date.'),
  to: emptyToNull.describe('Receipt date YYYY-MM-DD inclusive end date.'),
  limit: z.number().int().min(1).max(50).default(25),
});

const receiptEditFieldsSchema = z.object({
  setMerchant: z.boolean().default(false),
  merchant: z.string().trim().min(1).max(160).nullable().optional(),
  setTotalCents: z.boolean().default(false),
  totalCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
  setReceiptDate: z.boolean().default(false),
  receiptDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

const receiptUpdateSchema = receiptEditFieldsSchema.extend({
  receiptId: z.string().uuid(),
});

const receiptPairingSchema = receiptEditFieldsSchema.extend({
  receiptId: z.string().uuid(),
  transactionId: z.string().uuid(),
});

export const assistantToolDefinitions = [
  functionTool('list_businesses', 'List active businesses with display colors and ids. Use before filtering when a business name is ambiguous.', z.object({})),
  functionTool('list_accounts', 'List safe Plaid account balance and sync metadata. Does not include full account numbers or tokens.', z.object({
    business: emptyToNull,
    includeDisabled: z.boolean().default(false),
  })),
  functionTool('query_transactions', `Return safe transaction rows. Default max ${DEFAULT_TRANSACTION_DETAIL_LIMIT}; more requires explicit user approval. Excludes raw Plaid payloads.`, queryTransactionsSchema),
  functionTool('get_transaction_rollup', 'Return totals/counts matching transaction filters. Use before listing rows when totals matter.', transactionFilterSchema),
  functionTool('get_cash_flow', 'Return cash-basis inflow/outflow/net periods with YoY comparison. Transfers are excluded by default.', cashFlowSchema),
  functionTool('get_owner_insights', 'Return top purchases, missing receipts, uncategorized spend, transfers, income by business, and close summary.', ownerInsightsSchema),
  functionTool('get_account_balances', 'Return current/available balances grouped into bank cash and credit cards. Historical balance trends are unavailable.', z.object({ business: emptyToNull })),
  functionTool('query_receipts', 'Return safe receipt inbox rows for matching. Does not include raw receipt files or signed download URLs.', queryReceiptsSchema),
  functionTool('propose_transaction_update', 'Prepare a single transaction edit. Does not mutate until user confirms the approval card.', transactionUpdateSchema),
  functionTool('propose_bulk_transaction_update', `Prepare a bulk transaction edit for up to ${ASSISTANT_MUTATION_LIMIT} exact ids. Does not mutate until user confirms.`, bulkTransactionUpdateSchema),
  functionTool('propose_category_rule', 'Prepare a merchant/category rule. Does not mutate until user confirms the approval card.', categoryRuleSchema),
  functionTool('propose_receipt_update', 'Prepare a receipt metadata correction for merchant, amount, or date. Set the corresponding set* flag true only for fields the user wants changed. Does not mutate until user confirms.', receiptUpdateSchema),
  functionTool('propose_receipt_pairing', 'Prepare a receipt-to-transaction pairing. Optional receipt corrections are saved before pairing. Set set* flags true only for receipt fields the user wants changed. Does not mutate until user confirms.', receiptPairingSchema),
];

export async function callAssistantTool(name: string, rawArgs: unknown, context: AssistantToolContext): Promise<AssistantToolResult> {
  try {
    switch (name) {
      case 'list_businesses':
        return ok('Listed active businesses.', await listBusinesses());
      case 'list_accounts': {
        const args = z.object({ business: emptyToNull, includeDisabled: z.boolean().default(false) }).parse(rawArgs);
        return ok('Listed accounts and balances.', await listAccounts(args.business, args.includeDisabled));
      }
      case 'query_transactions':
        return queryTransactions(queryTransactionsSchema.parse(rawArgs), context);
      case 'get_transaction_rollup':
        return ok('Calculated transaction rollup.', await getTransactionRollup(transactionFilterSchema.parse(rawArgs)));
      case 'get_cash_flow':
        return getCashFlow(cashFlowSchema.parse(rawArgs));
      case 'get_owner_insights':
        return getOwnerInsights(ownerInsightsSchema.parse(rawArgs));
      case 'get_account_balances':
        return ok('Retrieved account balances.', await getAccountBalances(z.object({ business: emptyToNull }).parse(rawArgs).business));
      case 'query_receipts':
        return queryReceipts(queryReceiptsSchema.parse(rawArgs));
      case 'propose_transaction_update':
        return proposeTransactionUpdate(transactionUpdateSchema.parse(rawArgs), context.user.id);
      case 'propose_bulk_transaction_update':
        return proposeBulkTransactionUpdate(bulkTransactionUpdateSchema.parse(rawArgs), context.user.id);
      case 'propose_category_rule':
        return proposeCategoryRule(categoryRuleSchema.parse(rawArgs), context.user.id);
      case 'propose_receipt_update':
        return proposeReceiptUpdate(receiptUpdateSchema.parse(rawArgs), context.user.id);
      case 'propose_receipt_pairing':
        return proposeReceiptPairing(receiptPairingSchema.parse(rawArgs), context.user.id);
      default:
        return { ok: false, message: `Unknown assistant tool: ${name}` };
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Tool call failed.' };
  }
}

export async function confirmAssistantAction(
  token: string,
  context: AssistantToolContext,
): Promise<ConfirmAssistantActionResult> {
  const envelope = verifyAssistantToken(token, context.user.id);
  if (!envelope) throw new Error('This approval expired or is invalid. Ask the assistant to prepare it again.');
  const payload = envelope.payload;
  if (payload.kind === 'data_expansion') {
    return { ok: true, message: 'Expanded data approved for the next assistant request.' };
  }
  if (payload.kind === 'transaction_update') {
    const update = transactionUpdatePayload(payload);
    const [row] = await db.update(transactions).set(update).where(eq(transactions.id, payload.transactionId)).returning();
    if (!row) throw new Error('Transaction not found.');
    await audit(context.request!, context.user, 'assistant_update_transaction', 'transaction', payload.transactionId, redactPayload(payload));
    return {
      ok: true,
      message: 'Transaction updated.',
      artifact: await transactionArtifact([payload.transactionId], 'Updated transaction'),
    };
  }
  if (payload.kind === 'bulk_transaction_update') {
    if (payload.transactionIds.length > ASSISTANT_MUTATION_LIMIT) throw new Error('Bulk update exceeds assistant limit.');
    const update = transactionUpdatePayload(payload);
    await db.update(transactions).set(update).where(inArray(transactions.id, payload.transactionIds));
    await audit(context.request!, context.user, 'assistant_bulk_update_transactions', 'transaction', undefined, {
      count: payload.transactionIds.length,
      ...redactPayload(payload),
    });
    return {
      ok: true,
      message: `Updated ${payload.transactionIds.length} transactions.`,
      artifact: await transactionArtifact(payload.transactionIds, 'Updated transactions'),
    };
  }
  if (payload.kind === 'category_rule') {
    const [rule] = await db.insert(categoryRules).values({
      businessId: payload.businessId ?? null,
      categoryId: payload.categoryId,
      matchKind: payload.matchKind,
      pattern: normalizeRulePattern(payload.pattern),
      priority: payload.priority,
      createdByAi: true,
    }).returning();
    await audit(context.request!, context.user, 'assistant_create_category_rule', 'category_rule', rule.id, redactPayload(payload));
    return { ok: true, message: 'Category rule created.' };
  }
  if (payload.kind === 'receipt_update') {
    await applyReceiptUpdates(payload.receiptId, payload.updates);
    await audit(context.request!, context.user, 'assistant_update_receipt', 'receipt', payload.receiptId, redactPayload(payload));
    return {
      ok: true,
      message: 'Receipt details updated.',
      artifact: await receiptArtifact([payload.receiptId], 'Updated receipt'),
    };
  }
  if (payload.kind === 'receipt_pairing') {
    await confirmReceiptPairing(payload.receiptId, payload.transactionId, payload.updates);
    await audit(context.request!, context.user, 'assistant_pair_receipt', 'receipt', payload.receiptId, redactPayload(payload));
    return {
      ok: true,
      message: 'Receipt paired to transaction.',
      artifact: await transactionArtifact([payload.transactionId], 'Paired transaction'),
    };
  }
  return { ok: false, message: 'Unsupported approval payload.' };
}

export function toolEventDetail(name: string, status: 'called' | 'succeeded' | 'failed'): string {
  const verb = status === 'called' ? 'Calling' : status === 'succeeded' ? 'Finished' : 'Tool failed';
  const labels: Record<string, string> = {
    list_businesses: 'business lookup',
    list_accounts: 'account balance lookup',
    query_transactions: 'transaction search',
    get_transaction_rollup: 'transaction totals',
    get_cash_flow: 'cash-flow report',
    get_owner_insights: 'owner insights',
    get_account_balances: 'balance report',
    query_receipts: 'receipt inbox search',
    propose_transaction_update: 'transaction edit proposal',
    propose_bulk_transaction_update: 'bulk edit proposal',
    propose_category_rule: 'category rule proposal',
    propose_receipt_update: 'receipt edit proposal',
    propose_receipt_pairing: 'receipt pairing proposal',
  };
  return `${verb} ${labels[name] ?? name}.`;
}

function functionTool(name: string, description: string, schema: z.ZodTypeAny) {
  return {
    type: 'function' as const,
    name,
    description,
    parameters: zodToJsonSchema(name, schema),
    strict: true,
  };
}

function zodToJsonSchema(name: string, _schema: z.ZodTypeAny) {
  // Keep schemas explicit and strict for the OpenAI API. Runtime validation above remains the source of truth.
  const all = { type: ['string', 'null'] as const };
  const list = { type: 'array', items: { type: 'string' } };
  const bool = { type: 'boolean' as const };
  const int = { type: 'integer' as const };
  const nullableInt = { type: ['integer', 'null'] as const };
  const receiptEditProperties = {
    setMerchant: bool,
    merchant: all,
    setTotalCents: bool,
    totalCents: nullableInt,
    setReceiptDate: bool,
    receiptDate: all,
  };
  const commonFilters = {
    business: all,
    from: all,
    to: all,
    q: all,
    accountIds: list,
    categories: list,
    receipts: { type: 'array', items: { type: 'string', enum: ['matched', 'pending', 'missing', 'n/a'] }, default: [] },
    direction: { type: 'string', enum: ['all', 'inflow', 'outflow', 'operating-outflow', 'transfer'] },
  };
  const schemas: Record<string, Record<string, unknown>> = {
    list_businesses: {},
    list_accounts: { business: all, includeDisabled: bool },
    query_transactions: {
      ...commonFilters,
      limit: { ...int, minimum: 1, maximum: EXPANDED_TRANSACTION_DETAIL_LIMIT },
      sort: { type: 'string', enum: ['date', 'amount', 'largest', 'merchant', 'business', 'category', 'account'] },
      dir: { type: 'string', enum: ['asc', 'desc'] },
    },
    get_transaction_rollup: commonFilters,
    get_cash_flow: {
      business: all,
      accountIds: list,
      from: all,
      to: all,
      group: { type: 'string', enum: ['month', 'year'] },
      includeTransfers: bool,
    },
    get_owner_insights: { business: all, accountIds: list, from: all, to: all },
    get_account_balances: { business: all },
    query_receipts: {
      business: all,
      status: { type: ['string', 'null'], enum: ['matched', 'pending', 'missing', 'n/a', 'all', null] },
      source: { type: ['string', 'null'], enum: ['upload', 'gmail', 'all', null] },
      unmatched: bool,
      q: all,
      from: all,
      to: all,
      limit: { ...int, minimum: 1, maximum: 50 },
    },
    propose_transaction_update: {
      transactionId: { type: 'string' },
      categoryId: all,
      categoryName: all,
      businessId: all,
      business: all,
      note: all,
    },
    propose_bulk_transaction_update: {
      transactionIds: list,
      categoryId: all,
      categoryName: all,
      businessId: all,
      business: all,
      note: all,
    },
    propose_category_rule: {
      businessId: all,
      business: all,
      categoryId: { type: 'string' },
      matchKind: { type: 'string', enum: ['merchant_exact', 'merchant_contains', 'plaid_category', 'amount_range'] },
      pattern: { type: 'string' },
      priority: { ...int, minimum: 1, maximum: 999 },
    },
    propose_receipt_update: {
      receiptId: { type: 'string' },
      ...receiptEditProperties,
    },
    propose_receipt_pairing: {
      receiptId: { type: 'string' },
      transactionId: { type: 'string' },
      ...receiptEditProperties,
    },
  };
  const properties = schemas[name] ?? {};
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

async function listBusinesses() {
  const rows = await db.select().from(businesses).where(eq(businesses.active, true)).orderBy(businesses.name);
  return rows.map((row) => ({
    id: row.id,
    key: row.key,
    name: row.name,
    short: row.short,
    color: row.color,
  }));
}

async function listAccounts(business: string | null | undefined, includeDisabled: boolean) {
  const selectedBusiness = await resolveBusiness(business);
  const rows = await db
    .select({
      id: accounts.id,
      businessKey: businesses.key,
      businessName: businesses.name,
      name: accounts.name,
      nickname: accounts.nickname,
      kind: accounts.kind,
      mask: accounts.mask,
      enabled: accounts.enabled,
      currentBalanceCents: accounts.currentBalanceCents,
      availableBalanceCents: accounts.availableBalanceCents,
      connectionLabel: connections.label,
      connectionStatus: connections.status,
      lastSyncAt: connections.lastSyncAt,
    })
    .from(accounts)
    .innerJoin(connections, eq(accounts.connectionId, connections.id))
    .leftJoin(businesses, eq(accounts.businessId, businesses.id))
    .where(and(
      selectedBusiness ? eq(accounts.businessId, selectedBusiness.id) : sql`true`,
      includeDisabled ? sql`true` : eq(accounts.enabled, true),
    ))
    .orderBy(accounts.name);
  return rows.map((row) => ({
    ...row,
    mask: row.mask ? `•• ${row.mask.replace(/^••\s*/, '')}` : null,
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
  }));
}

async function queryTransactions(args: z.infer<typeof queryTransactionsSchema>, context: AssistantToolContext): Promise<AssistantToolResult> {
  if (needsExpandedDataApproval(args.limit, Boolean(context.expandedDataApproved))) {
    const approval = createApproval(context.user.id, {
      kind: 'data_expansion',
      requestedLimit: Math.min(args.limit, EXPANDED_TRANSACTION_DETAIL_LIMIT),
      purpose: `Return up to ${Math.min(args.limit, EXPANDED_TRANSACTION_DETAIL_LIMIT)} transaction rows for this assistant question.`,
    }, 'Approve expanded transaction detail', `This request asks for ${args.limit} rows. I can share up to ${EXPANDED_TRANSACTION_DETAIL_LIMIT} sanitized transaction rows with OpenAI if you approve.`, `Allow ${Math.min(args.limit, EXPANDED_TRANSACTION_DETAIL_LIMIT)} rows`);
    return {
      ok: true,
      message: `The request needs approval because it asks for more than ${DEFAULT_TRANSACTION_DETAIL_LIMIT} transaction rows.`,
      approvalRequests: [approval],
      data: { requiresApproval: true, defaultLimit: DEFAULT_TRANSACTION_DETAIL_LIMIT, requestedLimit: args.limit },
    };
  }

  const limit = requestedTransactionLimit(args.limit, Boolean(context.expandedDataApproved));
  const selectedBusiness = await resolveBusiness(args.business);
  const filters = await transactionFilters({ ...args, businessId: selectedBusiness?.id ?? null });
  const sortDirection = args.dir === 'asc' ? asc : desc;
  const rows = await db
    .select({
      ...getTableColumns(transactions),
      businessKey: businesses.key,
      businessName: businesses.name,
      categoryName: categories.name,
      categoryTaxCode: categories.taxCode,
    })
    .from(transactions)
    .innerJoin(businesses, eq(transactions.businessId, businesses.id))
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(and(...filters))
    .orderBy(sortDirection(transactionSortColumn(args.sort)), desc(transactions.createdAt))
    .limit(limit);
  const safeRows = rows.map(safeTransactionRow);
  return {
    ok: true,
    message: `Returned ${safeRows.length} sanitized transaction rows.`,
    data: {
      rows: safeRows,
      limit,
      cashBasisNote: 'Cash-basis from Plaid transactions. Transfers are visible but excluded from operating views by default.',
    },
    artifacts: [transactionsArtifact(safeRows, 'Matching transactions')],
  };
}

async function getTransactionRollup(args: z.infer<typeof transactionFilterSchema>) {
  const selectedBusiness = await resolveBusiness(args.business);
  const filters = await transactionFilters({ ...args, businessId: selectedBusiness?.id ?? null });
  const [row] = await db
    .select({
      rows: sql<number>`count(${transactions.id})::int`,
      inflowCents: sql<number>`coalesce(sum(CASE WHEN ${transactions.amountCents} > 0 THEN ${transactions.amountCents} ELSE 0 END), 0)::int`,
      outflowCents: sql<number>`coalesce(abs(sum(CASE WHEN ${transactions.amountCents} < 0 THEN ${transactions.amountCents} ELSE 0 END)), 0)::int`,
      operatingOutflowCents: sql<number>`coalesce(abs(sum(CASE WHEN ${transactions.amountCents} < 0 AND ${categoryIsVisibleSpend()} THEN ${transactions.amountCents} ELSE 0 END)), 0)::int`,
      transferCents: sql<number>`coalesce(sum(CASE WHEN ${transferCategoryFilter()} THEN abs(${transactions.amountCents}) ELSE 0 END), 0)::int`,
      netCents: sql<number>`coalesce(sum(${transactions.amountCents}), 0)::int`,
      missingReceipts: sql<number>`count(${transactions.id}) FILTER (WHERE ${transactions.receiptStatus} = 'missing')::int`,
    })
    .from(transactions)
    .innerJoin(businesses, eq(transactions.businessId, businesses.id))
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(and(...filters));
  return {
    rows: Number(row?.rows ?? 0),
    inflowCents: Number(row?.inflowCents ?? 0),
    outflowCents: Number(row?.outflowCents ?? 0),
    operatingOutflowCents: Number(row?.operatingOutflowCents ?? 0),
    transferCents: Number(row?.transferCents ?? 0),
    netCents: Number(row?.netCents ?? 0),
    missingReceipts: Number(row?.missingReceipts ?? 0),
  };
}

async function getCashFlow(args: z.infer<typeof cashFlowSchema>): Promise<AssistantToolResult> {
  const to = args.to ?? isoDate(new Date());
  const from = args.from ?? isoDate(new Date(dateFromIso(to).getFullYear(), 0, 1));
  const selectedBusiness = await resolveBusiness(args.business);
  const periods = cashFlowPeriods(from, to, args.group);
  const rows = await Promise.all(periods.map(async (period) => {
    const [current, previous, businessBreakdown] = await Promise.all([
      cashFlowTotals(period.from, period.to, selectedBusiness?.id ?? null, args.accountIds, args.includeTransfers),
      cashFlowTotals(shiftIsoYear(period.from, -1), shiftIsoYear(period.to, -1), selectedBusiness?.id ?? null, args.accountIds, args.includeTransfers),
      cashFlowBusinessBreakdown(period.from, period.to, selectedBusiness?.id ?? null, args.accountIds, args.includeTransfers),
    ]);
    return {
      label: period.label,
      from: period.from,
      to: period.to,
      ...current,
      previousInflowCents: previous.inflowCents,
      previousOutflowCents: previous.outflowCents,
      previousTransferCents: previous.transferCents,
      previousNetCents: previous.netCents,
      netDeltaCents: current.netCents - previous.netCents,
      businessBreakdown,
    };
  }));
  const data = {
    from,
    to,
    group: args.group,
    includeTransfers: args.includeTransfers,
    totals: sumCashFlowPeriods(rows),
    periods: rows,
    note: 'Cash-basis from Plaid transactions. Transfers are excluded unless includeTransfers is true.',
  };
  return {
    ok: true,
    message: 'Calculated cash flow.',
    data,
    artifacts: [cashFlowChart(data.periods, args.includeTransfers)],
  };
}

async function getOwnerInsights(args: z.infer<typeof ownerInsightsSchema>): Promise<AssistantToolResult> {
  const to = args.to ?? isoDate(new Date());
  const from = args.from ?? isoDate(new Date(dateFromIso(to).getFullYear(), dateFromIso(to).getMonth(), 1));
  const selectedBusiness = await resolveBusiness(args.business);
  const filters = [
    gte(transactions.date, from),
    lte(transactions.date, to),
    selectedBusiness ? eq(transactions.businessId, selectedBusiness.id) : sql`true`,
    accountSpendFilter(args.accountIds),
  ];
  const [topPurchases, missingReceipts, uncategorized, transferVolume, incomeByBusiness] = await Promise.all([
    db.select({
      ...getTableColumns(transactions),
      businessKey: businesses.key,
      businessName: businesses.name,
      categoryName: categories.name,
      categoryTaxCode: categories.taxCode,
    }).from(transactions)
      .innerJoin(businesses, eq(transactions.businessId, businesses.id))
      .leftJoin(categories, eq(transactions.categoryId, categories.id))
      .leftJoin(accounts, eq(transactions.accountId, accounts.id))
      .where(and(...filters, sql`${transactions.amountCents} < 0`, categoryIsVisibleSpend()))
      .orderBy(desc(sql`abs(${transactions.amountCents})`))
      .limit(12),
    metricQuery(filters, sql`${transactions.amountCents} < 0`, eq(transactions.receiptStatus, 'missing'), categoryIsVisibleSpend()),
    metricQuery(filters, sql`${transactions.amountCents} < 0`, categoryIsVisibleSpend(), or(sql`${categories.id} IS NULL`, eq(categories.name, 'Uncategorized'))!),
    metricQuery(filters, transferCategoryFilter()),
    db.select({
      businessId: businesses.key,
      businessName: businesses.name,
      color: businesses.color,
      cents: sql<number>`coalesce(sum(${transactions.amountCents}), 0)::int`,
      count: sql<number>`count(${transactions.id})::int`,
    }).from(transactions)
      .innerJoin(businesses, eq(transactions.businessId, businesses.id))
      .leftJoin(categories, eq(transactions.categoryId, categories.id))
      .leftJoin(accounts, eq(transactions.accountId, accounts.id))
      .where(and(...filters, sql`${transactions.amountCents} > 0`, sql`NOT (${transferCategoryFilter()})`))
      .groupBy(businesses.key, businesses.name, businesses.color)
      .orderBy(desc(sql`sum(${transactions.amountCents})`)),
  ]);
  const data = {
    from,
    to,
    topPurchases: topPurchases.map(safeTransactionRow),
    missingReceipts,
    uncategorized,
    transferVolume,
    incomeByBusiness: incomeByBusiness.map((row) => ({
      ...row,
      cents: Number(row.cents ?? 0),
      count: Number(row.count ?? 0),
    })),
  };
  return {
    ok: true,
    message: 'Retrieved owner/accountant insights.',
    data,
    artifacts: [
      transactionsArtifact(data.topPurchases, 'Top purchases'),
      {
        type: 'metric_grid',
        id: crypto.randomUUID(),
        title: 'Close signals',
        metrics: [
          metric('Missing receipts', String(missingReceipts.count), `${formatCents(missingReceipts.cents)} affected`, missingReceipts.count ? 'warning' : 'positive'),
          metric('Uncategorized spend', String(uncategorized.count), formatCents(uncategorized.cents), uncategorized.count ? 'warning' : 'positive'),
          metric('Transfer movement', String(transferVolume.count), formatCents(transferVolume.cents), 'muted'),
        ],
      },
    ],
  };
}

async function getAccountBalances(business: string | null | undefined) {
  const rows = await listAccounts(business, false);
  const bank = rows.filter((row) => row.kind !== 'credit');
  const credit = rows.filter((row) => row.kind === 'credit');
  return {
    note: 'Current Plaid balances only. Ledger AI does not store historical balance snapshots yet.',
    bankCashCents: bank.reduce((sum, row) => sum + (row.currentBalanceCents ?? 0), 0),
    bankAvailableCents: bank.reduce((sum, row) => sum + (row.availableBalanceCents ?? 0), 0),
    creditBalanceCents: credit.reduce((sum, row) => sum + (row.currentBalanceCents ?? 0), 0),
    creditAvailableCents: credit.reduce((sum, row) => sum + (row.availableBalanceCents ?? 0), 0),
    accounts: rows,
  };
}

async function queryReceipts(args: z.infer<typeof queryReceiptsSchema>): Promise<AssistantToolResult> {
  const selectedBusiness = await resolveBusiness(args.business);
  const rows = await db
    .select({
      ...getTableColumns(receipts),
      businessKey: businesses.key,
      businessName: businesses.name,
    })
    .from(receipts)
    .leftJoin(businesses, eq(receipts.businessId, businesses.id))
    .where(and(
      selectedBusiness ? eq(receipts.businessId, selectedBusiness.id) : sql`true`,
      args.status && args.status !== 'all' ? eq(receipts.status, args.status) : sql`true`,
      args.source && args.source !== 'all' ? eq(receipts.source, args.source) : sql`true`,
      args.unmatched ? isNull(receipts.transactionId) : sql`true`,
      args.from ? gte(receipts.receiptDate, args.from) : sql`true`,
      args.to ? lte(receipts.receiptDate, args.to) : sql`true`,
      args.q ? or(
        ilike(receipts.merchant, `%${args.q}%`),
        ilike(receipts.fileName, `%${args.q}%`),
        ilike(businesses.name, `%${args.q}%`),
      )! : sql`true`,
    ))
    .orderBy(desc(receipts.createdAt))
    .limit(args.limit);
  const safeRows = rows.map(safeReceiptRow);
  return {
    ok: true,
    message: `Returned ${safeRows.length} safe receipt rows.`,
    data: {
      rows: safeRows,
      note: 'Raw receipt files and signed download URLs are not shared with OpenAI.',
    },
    artifacts: [receiptsArtifact(safeRows, 'Receipt candidates')],
  };
}

async function proposeTransactionUpdate(args: z.infer<typeof transactionUpdateSchema>, userId: string): Promise<AssistantToolResult> {
  const payload = await buildTransactionUpdatePayload(args);
  const approval = createApproval(userId, {
    kind: 'transaction_update',
    transactionId: args.transactionId,
    ...payload,
  }, 'Confirm transaction update', describeTransactionUpdate(payload, 1), 'Apply update');
  return { ok: true, message: 'Prepared transaction update for confirmation.', approvalRequests: [approval], data: { pendingMutation: payload } };
}

async function proposeBulkTransactionUpdate(args: z.infer<typeof bulkTransactionUpdateSchema>, userId: string): Promise<AssistantToolResult> {
  const payload = await buildTransactionUpdatePayload(args);
  const approval = createApproval(userId, {
    kind: 'bulk_transaction_update',
    transactionIds: args.transactionIds,
    ...payload,
  }, 'Confirm bulk transaction update', describeTransactionUpdate(payload, args.transactionIds.length), `Update ${args.transactionIds.length} rows`);
  return { ok: true, message: 'Prepared bulk transaction update for confirmation.', approvalRequests: [approval], data: { pendingMutation: payload, count: args.transactionIds.length } };
}

async function proposeCategoryRule(args: z.infer<typeof categoryRuleSchema>, userId: string): Promise<AssistantToolResult> {
  const business = await resolveBusiness(args.business ?? args.businessId ?? null);
  const category = await db.query.categories.findFirst({ where: eq(categories.id, args.categoryId) });
  if (!category) throw new Error('Category not found.');
  const approval = createApproval(userId, {
    kind: 'category_rule',
    businessId: business?.id ?? args.businessId ?? null,
    categoryId: args.categoryId,
    matchKind: args.matchKind,
    pattern: args.pattern,
    priority: args.priority,
  }, 'Confirm category rule', `Create ${args.matchKind} rule "${args.pattern}" for ${category.name}${business ? ` in ${business.name}` : ''}.`, 'Create rule');
  return { ok: true, message: 'Prepared category rule for confirmation.', approvalRequests: [approval] };
}

async function proposeReceiptUpdate(args: z.infer<typeof receiptUpdateSchema>, userId: string): Promise<AssistantToolResult> {
  const receipt = await receiptById(args.receiptId);
  if (!receipt) throw new Error('Receipt not found.');
  const updates = receiptUpdatePayload(args);
  if (Object.keys(updates).length === 0) throw new Error('No receipt changes were provided.');
  const approval = createApproval(userId, {
    kind: 'receipt_update',
    receiptId: args.receiptId,
    updates,
  }, 'Confirm receipt update', describeReceiptUpdate(receipt, updates), 'Save receipt');
  return { ok: true, message: 'Prepared receipt update for confirmation.', approvalRequests: [approval], data: { pendingMutation: updates } };
}

async function proposeReceiptPairing(args: z.infer<typeof receiptPairingSchema>, userId: string): Promise<AssistantToolResult> {
  const [receipt, transaction] = await Promise.all([
    receiptById(args.receiptId),
    db.query.transactions.findFirst({ where: eq(transactions.id, args.transactionId) }),
  ]);
  if (!receipt) throw new Error('Receipt not found.');
  if (!transaction) throw new Error('Transaction not found.');
  assertPairingAllowed(receipt, transaction);
  const updates = receiptUpdatePayload(args);
  const approval = createApproval(userId, {
    kind: 'receipt_pairing',
    receiptId: args.receiptId,
    transactionId: args.transactionId,
    updates: Object.keys(updates).length ? updates : undefined,
  }, 'Confirm receipt pairing', describeReceiptPairing(receipt, transaction, updates), 'Pair receipt');
  return {
    ok: true,
    message: 'Prepared receipt pairing for confirmation.',
    approvalRequests: [approval],
    data: { pendingMutation: { receiptId: args.receiptId, transactionId: args.transactionId, updates } },
  };
}

async function buildTransactionUpdatePayload(args: {
  categoryId?: string | null;
  categoryName?: string | null;
  businessId?: string | null;
  business?: string | null;
  note?: string | null;
}) {
  const business = await resolveBusiness(args.business ?? args.businessId ?? null);
  const categoryId = args.categoryName !== undefined
    ? await resolveCategoryId(args.categoryName, business?.id ?? args.businessId ?? null)
    : args.categoryId;
  if (categoryId) {
    const category = await db.query.categories.findFirst({ where: eq(categories.id, categoryId) });
    if (!category) throw new Error('Category not found.');
  }
  if (args.businessId && !business) throw new Error('Business not found.');
  if (categoryId === undefined && business?.id === undefined && args.note === undefined) {
    throw new Error('No transaction changes were provided.');
  }
  return {
    categoryId,
    businessId: business?.id ?? args.businessId,
    note: args.note,
  };
}

function transactionUpdatePayload(payload: {
  categoryId?: string | null;
  businessId?: string | null;
  note?: string | null;
}) {
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if ('categoryId' in payload) {
    update.categoryId = payload.categoryId ?? null;
    update.categorySource = payload.categoryId ? 'manual' : 'uncategorized';
    update.categoryConfidence = payload.categoryId ? '1.0000' : null;
    update.categoryEvidence = payload.categoryId ? { source: 'assistant_confirmed' } : {};
  }
  if ('businessId' in payload) update.businessId = payload.businessId ?? null;
  if ('note' in payload) update.note = payload.note ?? null;
  return update;
}

function receiptUpdatePayload(args: {
  setMerchant?: boolean;
  merchant?: string | null;
  setTotalCents?: boolean;
  totalCents?: number | null;
  setReceiptDate?: boolean;
  receiptDate?: string | null;
}): AssistantReceiptUpdatePayload {
  const updates: AssistantReceiptUpdatePayload = {};
  if (args.setMerchant) {
    if (!args.merchant) throw new Error('Receipt merchant must be provided when setMerchant is true.');
    updates.merchant = args.merchant;
  }
  if (args.setTotalCents) {
    if (args.totalCents == null) throw new Error('Receipt total must be provided when setTotalCents is true.');
    updates.totalCents = args.totalCents;
  }
  if (args.setReceiptDate) {
    if (!args.receiptDate) throw new Error('Receipt date must be provided when setReceiptDate is true.');
    updates.receiptDate = args.receiptDate;
  }
  return updates;
}

async function applyReceiptUpdates(receiptId: string, updates: AssistantReceiptUpdatePayload | undefined): Promise<void> {
  if (!updates || Object.keys(updates).length === 0) return;
  const [updated] = await db
    .update(receipts)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(receipts.id, receiptId))
    .returning({ id: receipts.id });
  if (!updated) throw new Error('Receipt not found.');
}

async function confirmReceiptPairing(
  receiptId: string,
  transactionId: string,
  updates: AssistantReceiptUpdatePayload | undefined,
): Promise<void> {
  const [receipt, transaction] = await Promise.all([
    receiptById(receiptId),
    db.query.transactions.findFirst({ where: eq(transactions.id, transactionId) }),
  ]);
  if (!receipt) throw new Error('Receipt not found.');
  if (!transaction) throw new Error('Transaction not found.');
  assertPairingAllowed(receipt, transaction);
  await applyReceiptUpdates(receiptId, updates);
  const paired = await attachReceipt(transactionId, receiptId);
  if (!paired) throw new Error('Transaction not found.');
}

function assertPairingAllowed(
  receipt: typeof receipts.$inferSelect,
  transaction: typeof transactions.$inferSelect,
): void {
  if (receipt.transactionId && receipt.transactionId !== transaction.id) throw new Error('Receipt is already matched to another transaction.');
  if (transaction.receiptId && transaction.receiptId !== receipt.id) throw new Error('Transaction already has another receipt attached.');
  if (receipt.businessId && receipt.businessId !== transaction.businessId) throw new Error('Receipt and transaction belong to different businesses.');
}

function createApproval(
  userId: string,
  payload: Parameters<typeof signAssistantToken>[1],
  title: string,
  detail: string,
  buttonLabel: string,
): AssistantApprovalRequest {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
  return {
    id: crypto.randomUUID(),
    kind: payload.kind === 'data_expansion' ? 'data_expansion' : 'mutation',
    title,
    detail,
    token: signAssistantToken(userId, payload, 15 * 60 * 1000, undefined, now),
    buttonLabel,
    expiresAt,
  };
}

async function resolveBusiness(value?: string | null) {
  if (!value || value === 'all') return null;
  const normalized = value.toLowerCase();
  return db.query.businesses.findFirst({
    where: or(
      eq(businesses.id, value),
      eq(businesses.key, value),
      sql`lower(${businesses.name}) = ${normalized}`,
      sql`lower(${businesses.short}) = ${normalized}`,
    ),
  });
}

async function resolveCategoryId(value: string | null | undefined, businessId: string | null | undefined): Promise<string | null | undefined> {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const normalized = value.toLowerCase();
  const row = await db.query.categories.findFirst({
    where: and(
      sql`lower(${categories.name}) = ${normalized}`,
      businessId ? or(eq(categories.businessId, businessId), isNull(categories.businessId)) : sql`true`,
    ),
  });
  if (!row) throw new Error(`Category not found: ${value}`);
  return row.id;
}

async function transactionFilters(args: z.infer<typeof transactionFilterSchema> & { businessId?: string | null }): Promise<SQL[]> {
  return [
    args.businessId ? eq(transactions.businessId, args.businessId) : sql`true`,
    args.from ? gte(transactions.date, args.from) : sql`true`,
    args.to ? lte(transactions.date, args.to) : sql`true`,
    accountSpendFilter(args.accountIds),
    args.categories.length ? inArray(categories.name, args.categories) : sql`true`,
    args.receipts.length ? inArray(transactions.receiptStatus, args.receipts) : sql`true`,
    transactionDirectionFilter(args.direction),
    args.q ? or(
      ilike(transactions.merchant, `%${args.q}%`),
      ilike(transactions.sourceLabel, `%${args.q}%`),
      ilike(transactions.note, `%${args.q}%`),
      ilike(categories.name, `%${args.q}%`),
    )! : sql`true`,
  ];
}

function accountSpendFilter(accountIds: string[]) {
  return sql`(${transactions.accountId} IS NULL OR ${accounts.id} IS NULL OR ${accounts.enabled} = true)
    AND ${accountIds.length ? inArray(transactions.accountId, accountIds) : sql`true`}`;
}

function categoryIsVisibleSpend() {
  return sql`NOT (${transferCategoryFilter()})
    AND NOT (
      coalesce(${categories.taxCode}, '') = 'income'
      OR lower(coalesce(${categories.name}, '')) IN ('income', 'revenue')
    )`;
}

function transferCategoryFilter() {
  return sql`coalesce(${categories.taxCode}, '') LIKE 'exclude_%'
    OR lower(coalesce(${categories.name}, '')) = 'transfers'`;
}

function transactionDirectionFilter(direction: Direction) {
  switch (direction) {
    case 'inflow':
      return sql`${transactions.amountCents} > 0`;
    case 'outflow':
      return sql`${transactions.amountCents} < 0`;
    case 'operating-outflow':
      return sql`${transactions.amountCents} < 0 AND ${categoryIsVisibleSpend()}`;
    case 'transfer':
      return transferCategoryFilter();
    default:
      return sql`true`;
  }
}

function transactionSortColumn(sort: SortKey) {
  switch (sort) {
    case 'amount':
      return transactions.amountCents;
    case 'largest':
      return sql`abs(${transactions.amountCents})`;
    case 'merchant':
      return transactions.merchant;
    case 'business':
      return businesses.name;
    case 'category':
      return categories.name;
    case 'account':
      return transactions.sourceLabel;
    default:
      return transactions.date;
  }
}

async function cashFlowTotals(from: string, to: string, businessId: string | null, accountIds: string[], includeTransfers: boolean) {
  const inflowFilter = includeTransfers ? sql`true` : sql`NOT (${transferCategoryFilter()})`;
  const spendFilter = includeTransfers ? sql`true` : categoryIsVisibleSpend();
  const [row] = await db.select({
    inflowCents: sql<number>`coalesce(sum(CASE WHEN ${transactions.amountCents} > 0 AND ${inflowFilter} THEN ${transactions.amountCents} ELSE 0 END), 0)::int`,
    outflowCents: sql<number>`coalesce(abs(sum(CASE WHEN ${transactions.amountCents} < 0 AND ${spendFilter} THEN ${transactions.amountCents} ELSE 0 END)), 0)::int`,
    transferCents: sql<number>`coalesce(sum(CASE WHEN ${transferCategoryFilter()} THEN abs(${transactions.amountCents}) ELSE 0 END), 0)::int`,
    netCents: sql<number>`coalesce(sum(CASE WHEN ${transactions.amountCents} > 0 AND ${inflowFilter} THEN ${transactions.amountCents} WHEN ${transactions.amountCents} < 0 AND ${spendFilter} THEN ${transactions.amountCents} ELSE 0 END), 0)::int`,
  }).from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(and(gte(transactions.date, from), lte(transactions.date, to), businessId ? eq(transactions.businessId, businessId) : sql`true`, accountSpendFilter(accountIds)));
  return {
    inflowCents: Number(row?.inflowCents ?? 0),
    outflowCents: Number(row?.outflowCents ?? 0),
    transferCents: Number(row?.transferCents ?? 0),
    netCents: Number(row?.netCents ?? 0),
  };
}

async function cashFlowBusinessBreakdown(from: string, to: string, businessId: string | null, accountIds: string[], includeTransfers: boolean) {
  const inflowFilter = includeTransfers ? sql`true` : sql`NOT (${transferCategoryFilter()})`;
  const spendFilter = includeTransfers ? sql`true` : categoryIsVisibleSpend();
  const rows = await db.select({
    businessId: businesses.key,
    businessName: businesses.name,
    color: businesses.color,
    inflowCents: sql<number>`coalesce(sum(CASE WHEN ${transactions.amountCents} > 0 AND ${inflowFilter} THEN ${transactions.amountCents} ELSE 0 END), 0)::int`,
    outflowCents: sql<number>`coalesce(abs(sum(CASE WHEN ${transactions.amountCents} < 0 AND ${spendFilter} THEN ${transactions.amountCents} ELSE 0 END)), 0)::int`,
    transferCents: sql<number>`coalesce(sum(CASE WHEN ${transferCategoryFilter()} THEN abs(${transactions.amountCents}) ELSE 0 END), 0)::int`,
    netCents: sql<number>`coalesce(sum(CASE WHEN ${transactions.amountCents} > 0 AND ${inflowFilter} THEN ${transactions.amountCents} WHEN ${transactions.amountCents} < 0 AND ${spendFilter} THEN ${transactions.amountCents} ELSE 0 END), 0)::int`,
  }).from(transactions)
    .innerJoin(businesses, eq(transactions.businessId, businesses.id))
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(and(gte(transactions.date, from), lte(transactions.date, to), businessId ? eq(transactions.businessId, businessId) : sql`true`, accountSpendFilter(accountIds)))
    .groupBy(businesses.key, businesses.name, businesses.color);
  return rows.map((row) => ({
    businessId: row.businessId,
    businessName: row.businessName,
    color: row.color,
    inflowCents: Number(row.inflowCents ?? 0),
    outflowCents: Number(row.outflowCents ?? 0),
    transferCents: Number(row.transferCents ?? 0),
    netCents: Number(row.netCents ?? 0),
  }));
}

function cashFlowPeriods(from: string, to: string, group: 'month' | 'year') {
  const start = dateFromIso(from);
  const end = dateFromIso(to);
  const periods: Array<{ label: string; from: string; to: string }> = [];
  const cursor = group === 'year' ? new Date(start.getFullYear(), 0, 1) : new Date(start.getFullYear(), start.getMonth(), 1);
  while (cursor <= end) {
    const periodStart = group === 'year' ? new Date(cursor.getFullYear(), 0, 1) : new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const periodEnd = group === 'year' ? new Date(cursor.getFullYear(), 11, 31) : new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    periods.push({
      label: group === 'year' ? String(cursor.getFullYear()) : cursor.toLocaleString('en-US', { month: 'short', year: '2-digit' }),
      from: isoDate(periodStart < start ? start : periodStart),
      to: isoDate(periodEnd > end ? end : periodEnd),
    });
    if (group === 'year') cursor.setFullYear(cursor.getFullYear() + 1);
    else cursor.setMonth(cursor.getMonth() + 1);
  }
  return periods;
}

function sumCashFlowPeriods(rows: Array<{ inflowCents: number; outflowCents: number; transferCents: number; netCents: number; previousInflowCents: number; previousOutflowCents: number; previousTransferCents: number; previousNetCents: number }>) {
  const totals = rows.reduce((sum, row) => ({
    inflowCents: sum.inflowCents + row.inflowCents,
    outflowCents: sum.outflowCents + row.outflowCents,
    transferCents: sum.transferCents + row.transferCents,
    netCents: sum.netCents + row.netCents,
    previousInflowCents: sum.previousInflowCents + row.previousInflowCents,
    previousOutflowCents: sum.previousOutflowCents + row.previousOutflowCents,
    previousTransferCents: sum.previousTransferCents + row.previousTransferCents,
    previousNetCents: sum.previousNetCents + row.previousNetCents,
  }), { inflowCents: 0, outflowCents: 0, transferCents: 0, netCents: 0, previousInflowCents: 0, previousOutflowCents: 0, previousTransferCents: 0, previousNetCents: 0 });
  const netDeltaCents = totals.netCents - totals.previousNetCents;
  return { ...totals, netDeltaCents, netDeltaPct: totals.previousNetCents !== 0 ? Math.round((netDeltaCents / Math.abs(totals.previousNetCents)) * 100) : 0 };
}

async function metricQuery(baseFilters: SQL[], ...extraFilters: SQL[]) {
  const [row] = await db.select({
    count: sql<number>`count(${transactions.id})::int`,
    cents: sql<number>`coalesce(sum(abs(${transactions.amountCents})), 0)::int`,
  }).from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(and(...baseFilters, ...extraFilters));
  return { count: Number(row?.count ?? 0), cents: Number(row?.cents ?? 0) };
}

function safeTransactionRow(row: typeof transactions.$inferSelect & { businessKey?: string | null; businessName?: string | null; categoryName?: string | null; categoryTaxCode?: string | null }) {
  return {
    id: row.id,
    date: row.date,
    merchant: row.merchant,
    amountCents: row.amountCents,
    businessId: row.businessId,
    businessKey: row.businessKey ?? null,
    businessName: row.businessName ?? row.businessKey ?? row.businessId,
    accountId: row.accountId,
    categoryId: row.categoryId,
    category: row.categoryName ?? 'Uncategorized',
    categoryTaxCode: row.categoryTaxCode ?? null,
    receiptStatus: row.receiptStatus,
    sourceLabel: row.sourceLabel,
    note: row.note ?? null,
    pending: row.pending,
  };
}

function transactionsArtifact(rows: ReturnType<typeof safeTransactionRow>[], title: string): AssistantArtifact {
  const ids = rows.slice(0, DEFAULT_TRANSACTION_DETAIL_LIMIT).map((row) => row.id);
  return {
    type: 'transactions',
    id: crypto.randomUUID(),
    title,
    sources: [{ type: 'transactions', ids }],
    actions: [{ label: 'Open transactions', view: 'transactions' }],
    rows: rows.slice(0, DEFAULT_TRANSACTION_DETAIL_LIMIT).map((row) => ({
      id: row.id,
      date: row.date,
      merchant: row.merchant,
      business: row.businessName,
      category: row.category,
      account: row.sourceLabel,
      amountCents: row.amountCents,
      receiptStatus: row.receiptStatus,
    })),
  };
}

async function receiptById(id: string) {
  return db.query.receipts.findFirst({ where: eq(receipts.id, id) });
}

function safeReceiptRow(row: typeof receipts.$inferSelect & { businessKey?: string | null; businessName?: string | null }) {
  return {
    id: row.id,
    businessId: row.businessId,
    businessKey: row.businessKey ?? null,
    businessName: row.businessName ?? row.businessKey ?? row.businessId,
    source: row.source,
    status: row.status,
    merchant: row.merchant,
    totalCents: row.totalCents,
    receiptDate: row.receiptDate,
    fileName: row.fileName,
    mimeType: row.mimeType,
    transactionId: row.transactionId,
    confidence: row.confidence == null ? null : Number(row.confidence),
    createdAt: row.createdAt.toISOString(),
  };
}

function receiptsArtifact(rows: ReturnType<typeof safeReceiptRow>[], title: string): AssistantArtifact {
  const ids = rows.slice(0, DEFAULT_TRANSACTION_DETAIL_LIMIT).map((row) => row.id);
  return {
    type: 'table',
    id: crypto.randomUUID(),
    title,
    sources: [{ type: 'receipts', ids }],
    actions: [{ label: 'Open receipts', view: 'receipts' }],
    columns: [
      { key: 'date', label: 'Date', align: 'left' },
      { key: 'merchant', label: 'Merchant', align: 'left' },
      { key: 'business', label: 'Business', align: 'left' },
      { key: 'amount', label: 'Amount', align: 'right' },
      { key: 'source', label: 'Source', align: 'left' },
      { key: 'status', label: 'Status', align: 'left' },
    ],
    rows: rows.slice(0, DEFAULT_TRANSACTION_DETAIL_LIMIT).map((row) => ({
      cells: [
        row.receiptDate ?? 'Unknown',
        row.merchant ?? row.fileName ?? 'Receipt',
        row.businessName ?? 'Unassigned',
        row.totalCents == null ? 'Unknown' : formatCentsDetailed(row.totalCents),
        row.source,
        row.status,
      ],
    })),
  };
}

async function receiptArtifact(ids: string[], title: string): Promise<AssistantArtifact> {
  const rows = await db.select({
    ...getTableColumns(receipts),
    businessKey: businesses.key,
    businessName: businesses.name,
  }).from(receipts)
    .leftJoin(businesses, eq(receipts.businessId, businesses.id))
    .where(inArray(receipts.id, ids))
    .limit(DEFAULT_TRANSACTION_DETAIL_LIMIT);
  return receiptsArtifact(rows.map(safeReceiptRow), title);
}

async function transactionArtifact(ids: string[], title: string): Promise<AssistantArtifact> {
  const rows = await db.select({
    ...getTableColumns(transactions),
    businessKey: businesses.key,
    businessName: businesses.name,
    categoryName: categories.name,
    categoryTaxCode: categories.taxCode,
  }).from(transactions)
    .innerJoin(businesses, eq(transactions.businessId, businesses.id))
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(inArray(transactions.id, ids))
    .limit(DEFAULT_TRANSACTION_DETAIL_LIMIT);
  return transactionsArtifact(rows.map(safeTransactionRow), title);
}

function cashFlowChart(periods: Array<{ label: string; inflowCents: number; outflowCents: number; netCents: number }>, includeTransfers: boolean): AssistantArtifact {
  return {
    type: 'chart',
    id: crypto.randomUUID(),
    title: includeTransfers ? 'All Movement Cash Flow' : 'Operating Cash Flow',
    sources: [{ type: 'cash_flow', filters: { includeTransfers } }],
    actions: [{ label: 'Open cash flow', view: 'cash-flow', filters: { includeTransfers } }],
    chartType: 'bar',
    valueType: 'currency_cents',
    labels: periods.map((period) => period.label),
    series: [
      { name: 'Inflow', color: '#1F8A5B', values: periods.map((period) => period.inflowCents) },
      { name: 'Outflow', color: '#D97757', values: periods.map((period) => period.outflowCents) },
      { name: 'Net', color: '#2A6FDB', values: periods.map((period) => period.netCents) },
    ],
  };
}

function metric(label: string, value: string, detail: string | null, tone: 'default' | 'positive' | 'warning' | 'muted' | 'danger') {
  return { label, value, detail, tone };
}

function ok(message: string, data: unknown): AssistantToolResult {
  return { ok: true, message, data };
}

function formatCents(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cents / 100);
}

function formatCentsDetailed(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

function describeTransactionUpdate(payload: { categoryId?: string | null; businessId?: string | null; note?: string | null }, count: number): string {
  const parts = [];
  if ('categoryId' in payload) parts.push(payload.categoryId ? 'set category' : 'clear category');
  if ('businessId' in payload) parts.push(payload.businessId ? 'set business' : 'clear business');
  if ('note' in payload) parts.push(payload.note ? 'set note' : 'clear note');
  return `${parts.join(', ')} on ${count} transaction${count === 1 ? '' : 's'}.`;
}

function describeReceiptUpdate(
  receipt: typeof receipts.$inferSelect,
  updates: AssistantReceiptUpdatePayload,
): string {
  return `Update ${receiptLabel(receipt)}: ${describeReceiptUpdates(updates)}.`;
}

function describeReceiptPairing(
  receipt: typeof receipts.$inferSelect,
  transaction: typeof transactions.$inferSelect,
  updates: AssistantReceiptUpdatePayload,
): string {
  const receiptAmount = updates.totalCents ?? receipt.totalCents;
  const receiptDate = updates.receiptDate ?? receipt.receiptDate;
  const receiptMerchant = updates.merchant ?? receiptLabel(receipt);
  const corrections = Object.keys(updates).length ? ` Apply receipt corrections first: ${describeReceiptUpdates(updates)}.` : '';
  return `Pair ${receiptMerchant}${receiptDate ? ` from ${receiptDate}` : ''}${receiptAmount == null ? '' : ` for ${formatCentsDetailed(receiptAmount)}`} to ${transaction.merchant} ${formatCentsDetailed(transaction.amountCents)} on ${transaction.date}.${corrections}`;
}

function describeReceiptUpdates(updates: AssistantReceiptUpdatePayload): string {
  const parts = [];
  if ('merchant' in updates) parts.push(`set merchant to "${updates.merchant}"`);
  if ('totalCents' in updates && updates.totalCents != null) parts.push(`set total to ${formatCentsDetailed(updates.totalCents)}`);
  if ('receiptDate' in updates) parts.push(`set date to ${updates.receiptDate}`);
  return parts.join(', ') || 'no changes';
}

function receiptLabel(receipt: typeof receipts.$inferSelect): string {
  return receipt.merchant ?? receipt.fileName ?? 'receipt';
}

function redactPayload(payload: Record<string, unknown>) {
  const clone = { ...payload };
  delete clone.token;
  return clone;
}

function normalizeRulePattern(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function shiftIsoYear(value: string, delta: number): string {
  const date = dateFromIso(value);
  date.setFullYear(date.getFullYear() + delta);
  return isoDate(date);
}

function dateFromIso(value: string): Date {
  return new Date(`${value}T00:00:00`);
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
