import { and, asc, desc, eq, getTableColumns, gte, ilike, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { accounts, businesses, categories, connections, receipts, transactions } from '../db/schema.js';
import {
  createApproval,
  proposeBulkTransactionUpdate,
  proposeCategoryRule,
  proposeReceiptPairing,
  proposeReceiptUpdate,
  proposeTransactionUpdate,
} from './assistantActions.js';
import {
  cashFlowChart,
  formatCents,
  metric,
  receiptsArtifact,
  safeReceiptRow,
  safeTransactionRow,
  transactionsArtifact,
} from './assistantArtifacts.js';
import {
  DEFAULT_TRANSACTION_DETAIL_LIMIT,
  EXPANDED_TRANSACTION_DETAIL_LIMIT,
  needsExpandedDataApproval,
  requestedTransactionLimit,
} from './assistantSecurity.js';
import {
  bulkTransactionUpdateSchema,
  cashFlowSchema,
  categoryRuleSchema,
  emptyToNull,
  ownerInsightsSchema,
  queryReceiptsSchema,
  queryTransactionsSchema,
  receiptPairingSchema,
  receiptUpdateSchema,
  transactionFilterSchema,
  transactionUpdateSchema,
} from './assistantToolDefinitions.js';
import {
  accountSpendFilter,
  cashFlowBusinessBreakdown,
  cashFlowPeriods,
  cashFlowTotals,
  categoryIsVisibleSpend,
  dateFromIso,
  isoDate,
  metricQuery,
  resolveBusiness,
  shiftIsoYear,
  sumCashFlowPeriods,
  transactionFilters,
  transactionSortColumn,
  transferCategoryFilter,
} from './assistantQueryHelpers.js';
import type { AssistantToolContext, AssistantToolResult } from './assistantToolTypes.js';
export { confirmAssistantAction } from './assistantActions.js';
export { assistantToolDefinitions, toolEventDetail } from './assistantToolDefinitions.js';
export type { AssistantToolContext, AssistantToolResult, ConfirmAssistantActionResult } from './assistantToolTypes.js';

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

function ok(message: string, data: unknown): AssistantToolResult {
  return { ok: true, message, data };
}
