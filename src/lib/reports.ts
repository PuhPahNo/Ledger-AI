// Pure folds behind Reports › Overview.

import type { CashFlowPeriod } from '@/types/domain';
import { pctChange } from './periods';
import { parseLocalIsoDate, shiftIsoDays, shiftIsoMonths, startOfMonthIso, todayIso } from './dates';

export interface BusinessTotals {
  businessId: string;
  businessName: string;
  color: string;
  inflowCents: number;
  outflowCents: number;
  netCents: number;
}

/** Sum each business's inflow / outflow / net across cash-flow periods. */
export function sumBusinessBreakdown(periods: CashFlowPeriod[]): Map<string, BusinessTotals> {
  const totals = new Map<string, BusinessTotals>();
  for (const period of periods) {
    for (const row of period.businessBreakdown) {
      const entry = totals.get(row.businessId) ?? {
        businessId: row.businessId,
        businessName: row.businessName,
        color: row.color,
        inflowCents: 0,
        outflowCents: 0,
        netCents: 0,
      };
      entry.inflowCents += row.inflowCents;
      entry.outflowCents += row.outflowCents;
      entry.netCents += row.netCents;
      totals.set(row.businessId, entry);
    }
  }
  return totals;
}

export interface BusinessReportRow extends BusinessTotals {
  previousNetCents: number;
  netDeltaCents: number;
  netDeltaPct: number | null;
  /** Net per month across the trend window (sparkline). */
  trend: number[];
}

/**
 * One row per business with activity in the period, the prior period or the trend window,
 * sorted by net (best first). Businesses with no activity anywhere are omitted.
 */
export function businessReportRows(input: {
  current: CashFlowPeriod[];
  prior: CashFlowPeriod[];
  trend: CashFlowPeriod[];
}): BusinessReportRow[] {
  const current = sumBusinessBreakdown(input.current);
  const prior = sumBusinessBreakdown(input.prior);
  const meta = new Map<string, Pick<BusinessTotals, 'businessId' | 'businessName' | 'color'>>();
  for (const source of [input.current, input.prior, input.trend]) {
    for (const period of source) {
      for (const row of period.businessBreakdown) {
        if (!meta.has(row.businessId)) meta.set(row.businessId, { businessId: row.businessId, businessName: row.businessName, color: row.color });
      }
    }
  }
  return [...meta.values()]
    .map((info) => {
      const now = current.get(info.businessId);
      const before = prior.get(info.businessId);
      const netCents = now?.netCents ?? 0;
      const previousNetCents = before?.netCents ?? 0;
      return {
        ...info,
        inflowCents: now?.inflowCents ?? 0,
        outflowCents: now?.outflowCents ?? 0,
        netCents,
        previousNetCents,
        netDeltaCents: netCents - previousNetCents,
        netDeltaPct: pctChange(netCents, previousNetCents),
        trend: input.trend.map((period) => period.businessBreakdown.find((row) => row.businessId === info.businessId)?.netCents ?? 0),
      };
    })
    .sort((a, b) => b.netCents - a.netCents);
}

export interface ReportPreset {
  id: string;
  label: string;
  from: string;
  to: string;
}

/** Month-aligned report periods, newest first. "Last month" is the default: a closed month. */
export function reportPresets(today: string = todayIso()): ReportPreset[] {
  const monthStart = startOfMonthIso(parseLocalIsoDate(today));
  const lastMonthStart = shiftIsoMonths(monthStart, -1);
  const lastMonthEnd = shiftIsoDays(monthStart, -1);
  return [
    { id: 'last-month', label: 'Last month', from: lastMonthStart, to: lastMonthEnd },
    { id: 'this-month', label: 'This month', from: monthStart, to: today },
    { id: 'last-3', label: 'Last 3 months', from: shiftIsoMonths(monthStart, -2), to: today },
    { id: 'ytd', label: 'Year to date', from: `${today.slice(0, 4)}-01-01`, to: today },
    { id: 'last-12', label: 'Last 12 months', from: shiftIsoMonths(monthStart, -11), to: today },
  ];
}
