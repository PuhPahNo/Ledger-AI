import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireUser } from '../../auth/session.js';
import { db } from '../../db/client.js';
import { businesses, transactions } from '../../db/schema.js';
import {
  cashFlowBusinessBreakdown,
  cashFlowTotals,
  movementBusinessBreakdown,
  movementSummary,
  sumCashFlowPeriods,
} from './cashFlowData.js';
import {
  accountSpendFilter,
  averageCents,
  cashFlowPeriods,
  dateFromIso,
  dateWindow,
  flowBucketWindows,
  isoDate,
  parseAccountIds,
  previousDateWindow,
  shiftIsoYear,
  spendCategoryFilter,
  trailingMonthWindows,
  transferCategoryFilter,
} from './helpers.js';

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
    const period = query.period ?? new Date().toISOString().slice(0, 7);
    const { from, to, label } = dateWindow(period, query.from, query.to);
    const { priorFrom, priorTo } = previousDateWindow(from, to);
    const labels = trailingMonthWindows(to);
    const flowWindows = flowBucketWindows(from, to, query.bucketPreset);
    const selectedBusiness = query.biz && query.biz !== 'all'
      ? await db.query.businesses.findFirst({ where: eq(businesses.key, query.biz) })
      : null;
    const businessFilter = selectedBusiness ? eq(transactions.businessId, selectedBusiness.id) : sql`true`;
    const movementFilters = [businessFilter, accountSpendFilter(accountIds)] as const;
    const spendFilters = [
      ...movementFilters,
      sql`${transactions.amountCents} < 0`,
      spendCategoryFilter(),
    ] as const;
    const inflowFilters = [
      ...movementFilters,
      sql`${transactions.amountCents} > 0`,
      sql`NOT (${transferCategoryFilter()})`,
    ] as const;
    const current = await movementSummary(from, to, spendFilters, inflowFilters);
    const prior = await movementSummary(priorFrom, priorTo, spendFilters, inflowFilters);
    const [flowRows, flowOutflowBusinessRows, flowInflowBusinessRows] = await Promise.all([
      Promise.all(flowWindows.windows.map((window) => movementSummary(window.from, window.to, spendFilters, inflowFilters))),
      Promise.all(flowWindows.windows.map(({ from: bucketFrom, to: bucketTo }) => (
        movementBusinessBreakdown(bucketFrom, bucketTo, spendFilters, sql`abs(sum(${transactions.amountCents}))`)
      ))),
      Promise.all(flowWindows.windows.map(({ from: bucketFrom, to: bucketTo }) => (
        movementBusinessBreakdown(bucketFrom, bucketTo, inflowFilters, sql`sum(${transactions.amountCents})`)
      ))),
    ]);
    const trailingRows = await Promise.all(labels.map(async ({ from: monthFrom, to: monthTo }) => {
      return movementSummary(monthFrom, monthTo, spendFilters, inflowFilters);
    }));
    const [trailingOutflowBusinessRows, trailingInflowBusinessRows] = await Promise.all([
      Promise.all(labels.map(({ from: monthFrom, to: monthTo }) => (
        movementBusinessBreakdown(monthFrom, monthTo, spendFilters, sql`abs(sum(${transactions.amountCents}))`)
      ))),
      Promise.all(labels.map(({ from: monthFrom, to: monthTo }) => (
        movementBusinessBreakdown(monthFrom, monthTo, inflowFilters, sql`sum(${transactions.amountCents})`)
      ))),
    ]);
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
        inflowCents: flowRows[index]?.inflowCents ?? 0,
        outflowCents: flowRows[index]?.outflowCents ?? 0,
        netCents: flowRows[index]?.netCents ?? 0,
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
    const selectedBusiness = query.biz && query.biz !== 'all'
      ? await db.query.businesses.findFirst({ where: eq(businesses.key, query.biz) })
      : null;
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
