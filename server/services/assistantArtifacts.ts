import crypto from 'node:crypto';
import { eq, getTableColumns, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { businesses, categories, receipts, transactions } from '../db/schema.js';
import { DEFAULT_TRANSACTION_DETAIL_LIMIT } from './assistantSecurity.js';
import type { AssistantArtifact } from './assistantSchemas.js';

export function safeTransactionRow(row: typeof transactions.$inferSelect & {
  businessKey?: string | null;
  businessName?: string | null;
  categoryName?: string | null;
  categoryTaxCode?: string | null;
}) {
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

export function transactionsArtifact(rows: ReturnType<typeof safeTransactionRow>[], title: string): AssistantArtifact {
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

export async function receiptById(id: string) {
  return db.query.receipts.findFirst({ where: eq(receipts.id, id) });
}

export function safeReceiptRow(row: typeof receipts.$inferSelect & { businessKey?: string | null; businessName?: string | null }) {
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

export function receiptsArtifact(rows: ReturnType<typeof safeReceiptRow>[], title: string): AssistantArtifact {
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

export async function receiptArtifact(ids: string[], title: string): Promise<AssistantArtifact> {
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

export async function transactionArtifact(ids: string[], title: string): Promise<AssistantArtifact> {
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

export function cashFlowChart(periods: Array<{ label: string; inflowCents: number; outflowCents: number; netCents: number }>, includeTransfers: boolean): AssistantArtifact {
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
      // Colors are theme token names; the client resolves them to CSS variables.
      { name: 'Inflow', color: 'sage', values: periods.map((period) => period.inflowCents) },
      { name: 'Outflow', color: 'coral', values: periods.map((period) => period.outflowCents) },
      { name: 'Net', color: 'sky', values: periods.map((period) => period.netCents) },
    ],
  };
}

export function cashFlowBusinessTable(
  periods: Array<{ businessBreakdown: Array<{ businessId: string; businessName: string; inflowCents: number; outflowCents: number; netCents: number }> }>,
  includeTransfers: boolean,
): AssistantArtifact | null {
  const byBusiness = new Map<string, { name: string; inflowCents: number; outflowCents: number; netCents: number }>();
  for (const period of periods) {
    for (const row of period.businessBreakdown) {
      const current = byBusiness.get(row.businessId) ?? { name: row.businessName, inflowCents: 0, outflowCents: 0, netCents: 0 };
      current.inflowCents += row.inflowCents;
      current.outflowCents += row.outflowCents;
      current.netCents += row.netCents;
      byBusiness.set(row.businessId, current);
    }
  }
  if (byBusiness.size === 0) return null;
  const rows = [...byBusiness.values()].sort((a, b) => b.inflowCents - a.inflowCents);
  return {
    type: 'table',
    id: crypto.randomUUID(),
    title: includeTransfers ? 'Cash flow by business (all movement)' : 'Cash flow by business',
    sources: [{ type: 'cash_flow', filters: { includeTransfers } }],
    actions: [{ label: 'Open cash flow', view: 'cash-flow', filters: { includeTransfers } }],
    columns: [
      { key: 'business', label: 'Business', align: 'left' },
      { key: 'inflow', label: 'Inflow', align: 'right' },
      { key: 'outflow', label: 'Outflow', align: 'right' },
      { key: 'net', label: 'Net', align: 'right' },
    ],
    rows: rows.slice(0, 50).map((row) => ({
      cells: [row.name, formatCents(row.inflowCents), formatCents(row.outflowCents), formatCents(row.netCents)],
    })),
  };
}

export function rollupArtifact(rollup: {
  rows: number;
  inflowCents: number;
  outflowCents: number;
  operatingOutflowCents: number;
  transferCents: number;
  netCents: number;
  missingReceipts: number;
}): AssistantArtifact {
  return {
    type: 'metric_grid',
    id: crypto.randomUUID(),
    title: 'Transaction totals',
    sources: [{ type: 'transactions' }],
    actions: [{ label: 'Open transactions', view: 'transactions' }],
    metrics: [
      metric('Transactions', rollup.rows.toLocaleString('en-US'), null, 'default'),
      metric('Inflow', formatCents(rollup.inflowCents), null, 'positive'),
      metric('Operating outflow', formatCents(rollup.operatingOutflowCents), `${formatCents(rollup.outflowCents)} all outflow`, 'default'),
      metric('Net', formatCents(rollup.netCents), null, rollup.netCents >= 0 ? 'positive' : 'warning'),
      metric('Transfers', formatCents(rollup.transferCents), 'Excluded from operating views', 'muted'),
      metric('Missing receipts', rollup.missingReceipts.toLocaleString('en-US'), null, rollup.missingReceipts ? 'warning' : 'positive'),
    ],
  };
}

export function balancesArtifacts(balances: {
  bankCashCents: number;
  bankAvailableCents: number;
  creditBalanceCents: number;
  creditAvailableCents: number;
  accounts: Array<{
    name: string;
    nickname: string | null;
    businessName: string | null;
    kind: string;
    mask: string | null;
    currentBalanceCents: number | null;
    availableBalanceCents: number | null;
  }>;
}): AssistantArtifact[] {
  return [
    {
      type: 'metric_grid',
      id: crypto.randomUUID(),
      title: 'Current balances',
      actions: [{ label: 'Open balances', view: 'balances' }],
      metrics: [
        metric('Bank cash', formatCents(balances.bankCashCents), `${formatCents(balances.bankAvailableCents)} available`, 'positive'),
        metric('Credit card balance', formatCents(balances.creditBalanceCents), `${formatCents(balances.creditAvailableCents)} available credit`, 'warning'),
      ],
    },
    {
      type: 'table',
      id: crypto.randomUUID(),
      title: 'Accounts',
      actions: [{ label: 'Open balances', view: 'balances' }],
      columns: [
        { key: 'account', label: 'Account', align: 'left' },
        { key: 'business', label: 'Business', align: 'left' },
        { key: 'kind', label: 'Type', align: 'left' },
        { key: 'current', label: 'Current', align: 'right' },
        { key: 'available', label: 'Available', align: 'right' },
      ],
      rows: balances.accounts.slice(0, 50).map((row) => ({
        cells: [
          [row.nickname || row.name, row.mask].filter(Boolean).join(' '),
          row.businessName ?? 'Unassigned',
          row.kind,
          row.currentBalanceCents == null ? '—' : formatCentsDetailed(row.currentBalanceCents),
          row.availableBalanceCents == null ? '—' : formatCentsDetailed(row.availableBalanceCents),
        ],
      })),
    },
  ];
}

export function metric(label: string, value: string, detail: string | null, tone: 'default' | 'positive' | 'warning' | 'muted' | 'danger') {
  return { label, value, detail, tone };
}

export function formatCents(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cents / 100);
}

export function formatCentsDetailed(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}
