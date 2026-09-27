import type { FastifyInstance } from 'fastify';
import { and, eq, gte, ilike, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireUser } from '../../auth/session.js';
import { db } from '../../db/client.js';
import { accounts, businesses, categories, transactions } from '../../db/schema.js';
import {
  cashFlowBusinessBreakdown,
  cashFlowTotals,
  dailyBusinessMovement,
  movementForWindow,
  sumCashFlowPeriods,
} from './cashFlowData.js';
import {
  accountSpendFilter,
  averageCents,
  cashFlowPeriods,
  currentMonthKey,
  dateFromIso,
  dateWindow,
  flowBucketWindows,
  isoDate,
  parseAccountIds,
  previousDateWindow,
  shiftIsoYear,
  categoryIsVisibleSpend,
  trailingMonthWindows,
  resolveSelectedBusiness,
} from './helpers.js';
import { badRequest } from '../../lib/errors.js';

/** Longest window /summary/daily serves (13 months + a prior 13 months, with slack). */
const MAX_DAILY_SPAN_DAYS = 800;

/** Collapse per-business daily rows into one row per date, oldest first. */
export function foldDailyMovement(
  rows: Array<{ date: string; outflowCents: number; inflowCents: number }>,
): Array<{ date: string; outflowCents: number; inflowCents: number }> {
  const byDate = new Map<string, { date: string; outflowCents: number; inflowCents: number }>();
  for (const row of rows) {
    const entry = byDate.get(row.date) ?? { date: row.date, outflowCents: 0, inflowCents: 0 };
    entry.outflowCents += row.outflowCents;
    entry.inflowCents += row.inflowCents;
    byDate.set(row.date, entry);
  }
  return [...byDate.values()]
    .filter((row) => row.outflowCents !== 0 || row.inflowCents !== 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function registerSummaryRoutes(app: FastifyInstance): void {
  app.get('/summary', async (request) => {
    await requireUser(request);
    const query = z.object({
      period: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      label: z.string().optional(),
      biz: z.string().optional(),
      accounts: z.string().optional(),
      bucketPreset: z.enum(['month', 'last3', 'last12', 'ytd']).optional(),
    }).parse(request.query);
    const accountIds = parseAccountIds(query.accounts);
    const period = query.period ?? currentMonthKey();
    const { from, to, label } = dateWindow(period, query.from, query.to);
    const { priorFrom, priorTo } = previousDateWindow(from, to);
    const labels = trailingMonthWindows(to);
    const flowWindows = flowBucketWindows(from, to, query.bucketPreset);
    const selectedBusiness = await resolveSelectedBusiness(query.biz);
    const businessFilter = selectedBusiness ? eq(transactions.businessId, selectedBusiness.id) : sql`true`;
    // One grouped (day × business) query covering every window below — replaces the old
    // per-bucket / per-trailing-month fan-out (~3N + 36 queries per call).
    const allWindows = [
      { from, to },
      { from: priorFrom, to: priorTo },
      ...flowWindows.windows,
      ...labels,
    ];
    const spanFrom = allWindows.reduce((min, window) => (window.from < min ? window.from : min), from);
    const spanTo = allWindows.reduce((max, window) => (window.to > max ? window.to : max), to);
    const daily = await dailyBusinessMovement(spanFrom, spanTo, [businessFilter, accountSpendFilter(accountIds)]);
    const current = movementForWindow(daily, from, to);
    const prior = movementForWindow(daily, priorFrom, priorTo);
    const flowMovements = flowWindows.windows.map((window) => movementForWindow(daily, window.from, window.to));
    const flowOutflowBusinessRows = flowMovements.map((row) => row.outflowBusinessCents);
    const flowInflowBusinessRows = flowMovements.map((row) => row.inflowBusinessCents);
    const trailingRows = labels.map(({ from: monthFrom, to: monthTo }) => movementForWindow(daily, monthFrom, monthTo));
    const trailingOutflowBusinessRows = trailingRows.map((row) => row.outflowBusinessCents);
    const trailingInflowBusinessRows = trailingRows.map((row) => row.inflowBusinessCents);
    const trailingOutflowRows = trailingRows.map((row) => row.outflowCents);
    const trailingInflowRows = trailingRows.map((row) => row.inflowCents);
    const trailingNetRows = trailingRows.map((row) => row.netCents);
    const max = Math.max(...trailingOutflowRows, 1);
    const avgOutflow = averageCents(trailingOutflowRows);
    const avgInflow = averageCents(trailingInflowRows);
    const avgNet = averageCents(trailingNetRows);
    const currentTotal = current.outflowCents;
    const priorTotal = prior.outflowCents;
    return {
      totalCents: currentTotal,
      inflowCents: current.inflowCents,
      outflowCents: current.outflowCents,
      netCents: current.netCents,
      periodLabel: query.label ?? label,
      deltaPct: priorTotal > 0 ? Math.round(((currentTotal - priorTotal) / priorTotal) * 100) : 0,
      inflowDeltaPct: prior.inflowCents > 0 ? Math.round(((current.inflowCents - prior.inflowCents) / prior.inflowCents) * 100) : 0,
      outflowDeltaPct: priorTotal > 0 ? Math.round(((currentTotal - priorTotal) / priorTotal) * 100) : 0,
      netDeltaPct: prior.netCents !== 0 ? Math.round(((current.netCents - prior.netCents) / Math.abs(prior.netCents)) * 100) : 0,
      bucketGranularity: flowWindows.granularity,
      flowBuckets: flowWindows.windows.map((window, index) => ({
        label: window.label,
        from: window.from,
        to: window.to,
        inflowCents: flowMovements[index]?.inflowCents ?? 0,
        outflowCents: flowMovements[index]?.outflowCents ?? 0,
        netCents: flowMovements[index]?.netCents ?? 0,
        inflowBusinessCents: flowInflowBusinessRows[index] ?? [],
        outflowBusinessCents: flowOutflowBusinessRows[index] ?? [],
      })),
      trailingMonths: trailingOutflowRows.map((value) => Number((value / max).toFixed(3))),
      trailingMonthCents: trailingOutflowRows.map((value) => Number(value ?? 0)),
      trailingMonthBusinessCents: trailingOutflowBusinessRows,
      trailingInflowMonthCents: trailingInflowRows,
      trailingOutflowMonthCents: trailingOutflowRows,
      trailingNetMonthCents: trailingNetRows,
      trailingInflowBusinessCents: trailingInflowBusinessRows,
      trailingOutflowBusinessCents: trailingOutflowBusinessRows,
      trailingMonthLabels: labels.map((item) => item.label),
      lastMonthCents: prior.outflowCents,
      lastInflowCents: prior.inflowCents,
      lastOutflowCents: prior.outflowCents,
      lastNetCents: prior.netCents,
      avgMonthCents: avgOutflow,
      avgInflowCents: avgInflow,
      avgOutflowCents: avgOutflow,
      avgNetCents: avgNet,
    };
  });

  /**
   * Daily operating outflow / inflow for [from, to] — the Home spend-pace chart asks for the
   * prior window and the current window in one call and accumulates them client-side. Same
   * spend/inflow definitions as /summary (transfers and hidden categories excluded).
   */
  app.get('/summary/daily', async (request) => {
    await requireUser(request);
    const query = z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      biz: z.string().optional(),
      accounts: z.string().optional(),
    }).parse(request.query);
    if (query.to < query.from) badRequest('"to" must be on or after "from".');
    const spanDays = Math.round((dateFromIso(query.to).getTime() - dateFromIso(query.from).getTime()) / 86400000) + 1;
    if (spanDays > MAX_DAILY_SPAN_DAYS) badRequest(`Daily series are limited to ${MAX_DAILY_SPAN_DAYS} days.`);
    const accountIds = parseAccountIds(query.accounts);
    const selectedBusiness = await resolveSelectedBusiness(query.biz);
    const businessFilter = selectedBusiness ? eq(transactions.businessId, selectedBusiness.id) : sql`true`;
    const daily = await dailyBusinessMovement(query.from, query.to, [businessFilter, accountSpendFilter(accountIds)]);
    return { from: query.from, to: query.to, days: foldDailyMovement(daily) };
  });

  /**
   * Server-side breakdowns for the dashboard analysis/account tiles. Previously these were
   * computed in the browser from the first 2,000 transactions, which could disagree with
   * the hero totals; this uses the same operating-spend definition as /summary.
   */
  app.get('/summary/breakdowns', async (request) => {
    await requireUser(request);
    const query = z.object({
      from: z.string(),
      to: z.string(),
      biz: z.string().optional(),
      accounts: z.string().optional(),
      q: z.string().optional(),
    }).parse(request.query);
    const accountIds = parseAccountIds(query.accounts);
    const selectedBusiness = await resolveSelectedBusiness(query.biz);
    const spend = sql`${transactions.amountCents} < 0 AND ${categoryIsVisibleSpend()}`;
    const rows = await db.select({
      businessId: businesses.key,
      businessName: businesses.name,
      color: businesses.color,
      accountId: transactions.accountId,
      receiptStatus: transactions.receiptStatus,
      rows: sql<number>`count(${transactions.id})::int`,
      spendCount: sql<number>`count(${transactions.id}) FILTER (WHERE ${spend})::int`,
      spendCents: sql<number>`coalesce(abs(sum(CASE WHEN ${spend} THEN ${transactions.amountCents} ELSE 0 END)), 0)::bigint`,
    })
      .from(transactions)
      .innerJoin(businesses, eq(transactions.businessId, businesses.id))
      .leftJoin(categories, eq(transactions.categoryId, categories.id))
      .leftJoin(accounts, eq(transactions.accountId, accounts.id))
      .where(and(
        gte(transactions.date, query.from),
        lte(transactions.date, query.to),
        selectedBusiness ? eq(transactions.businessId, selectedBusiness.id) : sql`true`,
        accountSpendFilter(accountIds),
        query.q ? or(
          ilike(transactions.merchant, `%${query.q}%`),
          ilike(transactions.sourceLabel, `%${query.q}%`),
          ilike(transactions.note, `%${query.q}%`),
          ilike(categories.name, `%${query.q}%`),
        ) : sql`true`,
      ))
      .groupBy(businesses.key, businesses.name, businesses.color, transactions.accountId, transactions.receiptStatus);
    return summarizeBreakdownRows(rows.map((row) => ({
      ...row,
      rows: Number(row.rows ?? 0),
      spendCount: Number(row.spendCount ?? 0),
      spendCents: Number(row.spendCents ?? 0),
    })));
  });

  app.get('/cash-flow', async (request) => {
    await requireUser(request);
    const query = z.object({
      from: z.string().optional(),
      to: z.string().optional(),
      group: z.enum(['month', 'year']).default('month'),
      includeTransfers: z.enum(['true', 'false']).default('false'),
      biz: z.string().optional(),
      accounts: z.string().optional(),
    }).parse(request.query);
    const to = query.to ?? isoDate(new Date());
    const from = query.from ?? isoDate(new Date(dateFromIso(to).getFullYear(), 0, 1));
    const accountIds = parseAccountIds(query.accounts);
    const includeTransfers = query.includeTransfers === 'true';
    const selectedBusiness = await resolveSelectedBusiness(query.biz);
    const periods = cashFlowPeriods(from, to, query.group);
    const rows = await Promise.all(periods.map(async (period) => {
      const [current, previous, businessBreakdown, previousBusinessBreakdown] = await Promise.all([
        cashFlowTotals(period.from, period.to, selectedBusiness?.id ?? null, accountIds, includeTransfers),
        cashFlowTotals(shiftIsoYear(period.from, -1), shiftIsoYear(period.to, -1), selectedBusiness?.id ?? null, accountIds, includeTransfers),
        cashFlowBusinessBreakdown(period.from, period.to, selectedBusiness?.id ?? null, accountIds, includeTransfers),
        cashFlowBusinessBreakdown(shiftIsoYear(period.from, -1), shiftIsoYear(period.to, -1), selectedBusiness?.id ?? null, accountIds, includeTransfers),
      ]);
      const previousNetByBusiness = new Map(previousBusinessBreakdown.map((row) => [row.businessId, row.netCents]));
      const netDeltaCents = current.netCents - previous.netCents;
      return {
        label: period.label,
        from: period.from,
        to: period.to,
        ...current,
        previousInflowCents: previous.inflowCents,
        previousOutflowCents: previous.outflowCents,
        previousTransferCents: previous.transferCents,
        previousNetCents: previous.netCents,
        netDeltaCents,
        netDeltaPct: previous.netCents !== 0 ? Math.round((netDeltaCents / Math.abs(previous.netCents)) * 100) : 0,
        businessBreakdown: businessBreakdown.map((row) => ({
          ...row,
          previousNetCents: previousNetByBusiness.get(row.businessId) ?? 0,
        })),
      };
    }));
    const totals = sumCashFlowPeriods(rows);
    return {
      from,
      to,
      group: query.group,
      includeTransfers,
      totals,
      periods: rows,
    };
  });
}

export interface BreakdownRow {
  businessId: string;
  businessName: string;
  color: string;
  accountId: string | null;
  receiptStatus: string;
  rows: number;
  spendCount: number;
  spendCents: number;
}

interface BreakdownBucket { key: string; label: string; color?: string; cents: number; count: number }

/** Fold (business × account × receipt status) rows into the three dashboard breakdowns. */
export function summarizeBreakdownRows(rows: BreakdownRow[]) {
  const byBusiness = new Map<string, BreakdownBucket>();
  const byAccount = new Map<string, BreakdownBucket>();
  const byReceipt = new Map<string, BreakdownBucket>();
  let totalRows = 0;
  let spendCents = 0;
  let spendCount = 0;
  const add = (map: Map<string, BreakdownBucket>, key: string, label: string, row: BreakdownRow, color?: string) => {
    const bucket = map.get(key) ?? { key, label, color, cents: 0, count: 0 };
    bucket.cents += row.spendCents;
    bucket.count += row.spendCount;
    map.set(key, bucket);
  };
  for (const row of rows) {
    totalRows += row.rows;
    if (!row.spendCount) continue;
    spendCents += row.spendCents;
    spendCount += row.spendCount;
    add(byBusiness, row.businessId, row.businessName, row, row.color);
    if (row.accountId) add(byAccount, row.accountId, row.accountId, row);
    add(byReceipt, row.receiptStatus, row.receiptStatus, row);
  }
  const sorted = (map: Map<string, BreakdownBucket>) => [...map.values()].sort((a, b) => b.cents - a.cents);
  return {
    rows: totalRows,
    spendCents,
    spendCount,
    byBusiness: sorted(byBusiness),
    byAccount: sorted(byAccount),
    byReceipt: sorted(byReceipt),
  };
}
