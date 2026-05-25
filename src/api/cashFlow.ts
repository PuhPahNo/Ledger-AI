import type { BusinessId, CashFlowGroup, CashFlowSummary, Transaction } from '@/types/domain';
import { http, useMockApi } from './client';
import { BUSINESSES, TRANSACTIONS, visibleMockTransactions } from './mocks';
import { isExcludedFromSpend } from '@/lib/calc';

export interface CashFlowParams {
  from?: string;
  to?: string;
  group?: CashFlowGroup;
  includeTransfers?: boolean;
  biz?: BusinessId | 'all';
  accountIds?: string[];
}

export function getCashFlow(params: CashFlowParams = {}): Promise<CashFlowSummary> {
  if (useMockApi) return Promise.resolve(mockCashFlow(params));
  const query = new URLSearchParams();
  if (params.from) query.set('from', params.from);
  if (params.to) query.set('to', params.to);
  if (params.group) query.set('group', params.group);
  if (params.includeTransfers) query.set('includeTransfers', 'true');
  if (params.biz && params.biz !== 'all') query.set('biz', params.biz);
  if (params.accountIds?.length) query.set('accounts', params.accountIds.join(','));
  return http<CashFlowSummary>(`/cash-flow?${query.toString()}`);
}

function mockCashFlow(params: CashFlowParams): CashFlowSummary {
  const to = params.to ?? today();
  const from = params.from ?? `${to.slice(0, 4)}-01-01`;
  const group = params.group ?? 'month';
  const includeTransfers = Boolean(params.includeTransfers);
  const periods = periodWindows(from, to, group).map((period) => {
    const rows = filterRows(params, period.from, period.to);
    const previousRows = filterRows(params, shiftYear(period.from, -1), shiftYear(period.to, -1));
    const current = summarizeCashFlow(rows, includeTransfers);
    const previous = summarizeCashFlow(previousRows, includeTransfers);
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
      businessBreakdown: BUSINESSES.map((business) => {
        const summary = summarizeCashFlow(rows.filter((row) => row.biz === business.id), includeTransfers);
        return {
          businessId: business.id,
          businessName: business.name,
          color: business.color,
          ...summary,
        };
      }).filter((row) => row.inflowCents || row.outflowCents || row.transferCents),
    };
  });
  const totals = periods.reduce((sum, period) => {
    sum.inflowCents += period.inflowCents;
    sum.outflowCents += period.outflowCents;
    sum.transferCents += period.transferCents;
    sum.netCents += period.netCents;
    sum.previousInflowCents += period.previousInflowCents;
    sum.previousOutflowCents += period.previousOutflowCents;
    sum.previousTransferCents += period.previousTransferCents;
    sum.previousNetCents += period.previousNetCents;
    return sum;
  }, {
    inflowCents: 0,
    outflowCents: 0,
    transferCents: 0,
    netCents: 0,
    previousInflowCents: 0,
    previousOutflowCents: 0,
    previousTransferCents: 0,
    previousNetCents: 0,
    netDeltaCents: 0,
    netDeltaPct: 0,
  });
  totals.netDeltaCents = totals.netCents - totals.previousNetCents;
  totals.netDeltaPct = totals.previousNetCents !== 0 ? Math.round((totals.netDeltaCents / Math.abs(totals.previousNetCents)) * 100) : 0;
  return { from, to, group, includeTransfers, totals, periods };
}

function filterRows(params: CashFlowParams, from: string, to: string): Transaction[] {
  return visibleMockTransactions(TRANSACTIONS, params.accountIds)
    .filter((row) => !params.biz || params.biz === 'all' || row.biz === params.biz)
    .filter((row) => row.date >= from && row.date <= to);
}

function summarizeCashFlow(rows: Transaction[], includeTransfers: boolean) {
  return rows.reduce((sum, row) => {
    const cents = Math.round(row.amount * 100);
    if (cents > 0) sum.inflowCents += cents;
    if (cents < 0 && (includeTransfers || !isExcludedFromSpend(row))) sum.outflowCents += Math.abs(cents);
    if (isExcludedFromSpend(row)) sum.transferCents += Math.abs(cents);
    if (cents > 0 || (cents < 0 && (includeTransfers || !isExcludedFromSpend(row)))) sum.netCents += cents;
    return sum;
  }, { inflowCents: 0, outflowCents: 0, transferCents: 0, netCents: 0 });
}

function periodWindows(from: string, to: string, group: CashFlowGroup) {
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  const cursor = group === 'year' ? new Date(start.getFullYear(), 0, 1) : new Date(start.getFullYear(), start.getMonth(), 1);
  const windows: Array<{ label: string; from: string; to: string }> = [];
  while (cursor <= end) {
    const periodStart = group === 'year' ? new Date(cursor.getFullYear(), 0, 1) : new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const periodEnd = group === 'year' ? new Date(cursor.getFullYear(), 11, 31) : new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    windows.push({
      label: group === 'year' ? String(cursor.getFullYear()) : cursor.toLocaleString('en-US', { month: 'short', year: '2-digit' }),
      from: isoDate(periodStart < start ? start : periodStart),
      to: isoDate(periodEnd > end ? end : periodEnd),
    });
    if (group === 'year') cursor.setFullYear(cursor.getFullYear() + 1);
    else cursor.setMonth(cursor.getMonth() + 1);
  }
  return windows;
}

function shiftYear(value: string, delta: number): string {
  const date = new Date(`${value}T00:00:00`);
  date.setFullYear(date.getFullYear() + delta);
  return isoDate(date);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
