import { and, eq, gte, ilike, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '../db/client.js';
import { accounts, businesses, categories, transactions } from '../db/schema.js';
import type { transactionFilterSchema } from './assistantToolDefinitions.js';

type Direction = 'all' | 'inflow' | 'outflow' | 'operating-outflow' | 'transfer';
type SortKey = 'date' | 'amount' | 'largest' | 'merchant' | 'business' | 'category' | 'account';

export async function resolveBusiness(value?: string | null) {
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

export async function resolveCategoryId(value: string | null | undefined, businessId: string | null | undefined): Promise<string | null | undefined> {
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

export async function transactionFilters(args: z.infer<typeof transactionFilterSchema> & { businessId?: string | null }): Promise<SQL[]> {
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

export function accountSpendFilter(accountIds: string[]) {
  return sql`(${transactions.accountId} IS NULL OR ${accounts.id} IS NULL OR ${accounts.enabled} = true)
    AND ${accountIds.length ? inArray(transactions.accountId, accountIds) : sql`true`}`;
}

export function categoryIsVisibleSpend() {
  return sql`NOT (${transferCategoryFilter()})
    AND NOT (
      coalesce(${categories.taxCode}, '') = 'income'
      OR lower(coalesce(${categories.name}, '')) IN ('income', 'revenue')
    )`;
}

export function transferCategoryFilter() {
  return sql`coalesce(${categories.taxCode}, '') LIKE 'exclude_%'
    OR lower(coalesce(${categories.name}, '')) = 'transfers'`;
}

export function transactionDirectionFilter(direction: Direction) {
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

export function transactionSortColumn(sort: SortKey) {
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

export async function cashFlowTotals(from: string, to: string, businessId: string | null, accountIds: string[], includeTransfers: boolean) {
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

export async function cashFlowBusinessBreakdown(from: string, to: string, businessId: string | null, accountIds: string[], includeTransfers: boolean) {
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

export function cashFlowPeriods(from: string, to: string, group: 'month' | 'year') {
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

export function sumCashFlowPeriods(rows: Array<{ inflowCents: number; outflowCents: number; transferCents: number; netCents: number; previousInflowCents: number; previousOutflowCents: number; previousTransferCents: number; previousNetCents: number }>) {
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

export async function metricQuery(baseFilters: SQL[], ...extraFilters: SQL[]) {
  const [row] = await db.select({
    count: sql<number>`count(${transactions.id})::int`,
    cents: sql<number>`coalesce(sum(abs(${transactions.amountCents})), 0)::int`,
  }).from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(and(...baseFilters, ...extraFilters));
  return { count: Number(row?.count ?? 0), cents: Number(row?.cents ?? 0) };
}

export function shiftIsoYear(value: string, delta: number): string {
  const date = dateFromIso(value);
  date.setFullYear(date.getFullYear() + delta);
  return isoDate(date);
}

export function dateFromIso(value: string): Date {
  return new Date(`${value}T00:00:00`);
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
