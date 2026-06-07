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
      { name: 'Inflow', color: '#1F8A5B', values: periods.map((period) => period.inflowCents) },
      { name: 'Outflow', color: '#D97757', values: periods.map((period) => period.outflowCents) },
      { name: 'Net', color: '#2A6FDB', values: periods.map((period) => period.netCents) },
    ],
  };
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
