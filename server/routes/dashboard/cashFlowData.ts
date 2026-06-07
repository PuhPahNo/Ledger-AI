import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { accounts, businesses, categories, transactions } from '../../db/schema.js';
import {
  accountSpendFilter,
  categoryIsVisibleSpend,
  transferCategoryFilter,
} from './helpers.js';

export interface MovementSummaryCents {
  inflowCents: number;
  outflowCents: number;
  netCents: number;
}

export async function movementSummary(
  from: string,
  to: string,
  spendFilters: readonly SQL[],
  inflowFilters: readonly SQL[],
): Promise<MovementSummaryCents> {
  const [[outflow], [inflow]] = await Promise.all([
    db.select({
      cents: sql<number>`coalesce(abs(sum(${transactions.amountCents})), 0)::int`,
    }).from(transactions)
      .leftJoin(accounts, eq(transactions.accountId, accounts.id))
      .leftJoin(categories, eq(transactions.categoryId, categories.id))
      .where(and(gte(transactions.date, from), lte(transactions.date, to), ...spendFilters)),
    db.select({
      cents: sql<number>`coalesce(sum(${transactions.amountCents}), 0)::int`,
    }).from(transactions)
      .leftJoin(accounts, eq(transactions.accountId, accounts.id))
      .leftJoin(categories, eq(transactions.categoryId, categories.id))
      .where(and(gte(transactions.date, from), lte(transactions.date, to), ...inflowFilters)),
  ]);
  const inflowCents = Number(inflow?.cents ?? 0);
  const outflowCents = Number(outflow?.cents ?? 0);
  return {
    inflowCents,
    outflowCents,
    netCents: inflowCents - outflowCents,
  };
}

export async function movementBusinessBreakdown(
  from: string,
  to: string,
  filters: readonly SQL[],
  aggregate: SQL,
): Promise<Array<{ businessId: string; businessName: string; color: string; cents: number }>> {
  const rows = await db.select({
    businessId: businesses.key,
    businessName: businesses.name,
    color: businesses.color,
    cents: sql<number>`coalesce(${aggregate}, 0)::int`,
  }).from(transactions)
    .innerJoin(businesses, eq(transactions.businessId, businesses.id))
    .leftJoin(accounts, eq(transactions.accountId, accounts.id))
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(and(gte(transactions.date, from), lte(transactions.date, to), ...filters))
    .groupBy(businesses.key, businesses.name, businesses.color);
  return rows
    .map((row) => ({
      businessId: row.businessId,
      businessName: row.businessName,
      color: row.color,
      cents: Number(row.cents ?? 0),
    }))
    .filter((row) => row.cents > 0)
    .sort((a, b) => b.cents - a.cents);
}

export async function cashFlowTotals(
  from: string,
  to: string,
  businessId: string | null,
  accountIds: string[],
  includeTransfers: boolean,
) {
  const inflowFilter = includeTransfers ? sql`true` : sql`NOT (${transferCategoryFilter()})`;
  const spendFilter = includeTransfers ? sql`true` : categoryIsVisibleSpend();
  const [row] = await db.select({
    inflowCents: sql<number>`coalesce(sum(CASE WHEN ${transactions.amountCents} > 0 AND ${inflowFilter} THEN ${transactions.amountCents} ELSE 0 END), 0)::int`,
    outflowCents: sql<number>`coalesce(abs(sum(CASE WHEN ${transactions.amountCents} < 0 AND ${spendFilter} THEN ${transactions.amountCents} ELSE 0 END)), 0)::int`,
    transferCents: sql<number>`coalesce(sum(CASE WHEN ${transferCategoryFilter()} THEN abs(${transactions.amountCents}) ELSE 0 END), 0)::int`,
  })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(and(
      gte(transactions.date, from),
      lte(transactions.date, to),
      businessId ? eq(transactions.businessId, businessId) : sql`true`,
      accountSpendFilter(accountIds),
    ));
  const inflowCents = Number(row?.inflowCents ?? 0);
  const outflowCents = Number(row?.outflowCents ?? 0);
  return {
    inflowCents,
    outflowCents,
    transferCents: Number(row?.transferCents ?? 0),
    netCents: inflowCents - outflowCents,
  };
}

export async function cashFlowBusinessBreakdown(
  from: string,
  to: string,
  businessId: string | null,
  accountIds: string[],
  includeTransfers: boolean,
) {
  const inflowFilter = includeTransfers ? sql`true` : sql`NOT (${transferCategoryFilter()})`;
  const spendFilter = includeTransfers ? sql`true` : categoryIsVisibleSpend();
  const rows = await db.select({
    businessId: businesses.key,
    businessName: businesses.name,
    color: businesses.color,
    inflowCents: sql<number>`coalesce(sum(CASE WHEN ${transactions.amountCents} > 0 AND ${inflowFilter} THEN ${transactions.amountCents} ELSE 0 END), 0)::int`,
    outflowCents: sql<number>`coalesce(abs(sum(CASE WHEN ${transactions.amountCents} < 0 AND ${spendFilter} THEN ${transactions.amountCents} ELSE 0 END)), 0)::int`,
    transferCents: sql<number>`coalesce(sum(CASE WHEN ${transferCategoryFilter()} THEN abs(${transactions.amountCents}) ELSE 0 END), 0)::int`,
  })
    .from(transactions)
    .innerJoin(businesses, eq(transactions.businessId, businesses.id))
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(and(
      gte(transactions.date, from),
      lte(transactions.date, to),
      businessId ? eq(transactions.businessId, businessId) : sql`true`,
      accountSpendFilter(accountIds),
    ))
    .groupBy(businesses.key, businesses.name, businesses.color)
    .orderBy(desc(sql`abs(sum(${transactions.amountCents}))`));
  return rows.map((row) => {
    const inflowCents = Number(row.inflowCents ?? 0);
    const outflowCents = Number(row.outflowCents ?? 0);
    return {
      businessId: row.businessId,
      businessName: row.businessName,
      color: row.color,
      inflowCents,
      outflowCents,
      transferCents: Number(row.transferCents ?? 0),
      netCents: inflowCents - outflowCents,
    };
  });
}

export function sumCashFlowPeriods(rows: Array<{
  inflowCents: number;
  outflowCents: number;
  transferCents: number;
  netCents: number;
  previousInflowCents: number;
  previousOutflowCents: number;
  previousTransferCents: number;
  previousNetCents: number;
}>) {
  const totals = rows.reduce((sum, row) => ({
    inflowCents: sum.inflowCents + row.inflowCents,
    outflowCents: sum.outflowCents + row.outflowCents,
    transferCents: sum.transferCents + row.transferCents,
    netCents: sum.netCents + row.netCents,
    previousInflowCents: sum.previousInflowCents + row.previousInflowCents,
    previousOutflowCents: sum.previousOutflowCents + row.previousOutflowCents,
    previousTransferCents: sum.previousTransferCents + row.previousTransferCents,
    previousNetCents: sum.previousNetCents + row.previousNetCents,
  }), {
    inflowCents: 0,
    outflowCents: 0,
    transferCents: 0,
    netCents: 0,
    previousInflowCents: 0,
    previousOutflowCents: 0,
    previousTransferCents: 0,
    previousNetCents: 0,
  });
  const netDeltaCents = totals.netCents - totals.previousNetCents;
  return {
    ...totals,
    netDeltaCents,
    netDeltaPct: totals.previousNetCents !== 0 ? Math.round((netDeltaCents / Math.abs(totals.previousNetCents)) * 100) : 0,
  };
}
