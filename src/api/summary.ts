import type { Business, BusinessId, SpendSummary, Transaction } from '@/types/domain';
import { isSpendTransaction, isTransferTransaction } from '@/lib/calc';
import type { DailyMovement } from '@/lib/periods';
import { http, useMockApi } from './client';
import { mapSummary, type ApiSpendSummary } from './mapper';
import { BUSINESSES, SUMMARY, TRANSACTIONS, visibleMockTransactions } from './mocks';

/**
 * GET /api/summary?period=YYYY-MM
 * Returns the dashboard hero summary: this period's outflow, MoM delta,
 * trailing-12 sparkline points, last month and avg month for comparison.
 */
export function getSummary(params: {
  period?: string;
  from?: string;
  to?: string;
  label?: string;
  biz?: BusinessId | 'all';
  accountIds?: string[];
  bucketPreset?: 'month' | 'last3' | 'last12' | 'ytd';
} = {}): Promise<SpendSummary> {
  if (useMockApi) {
    const visibleTransactions = visibleMockTransactions(TRANSACTIONS, params.accountIds);
    const rows = visibleTransactions
      .filter((txn) => !params.biz || params.biz === 'all' || txn.biz === params.biz)
      .filter((txn) => !params.from || txn.date >= params.from)
      .filter((txn) => !params.to || txn.date <= params.to);
    const inflow = rows.filter((txn) => txn.amount > 0).reduce((sum, txn) => sum + txn.amount, 0);
    const outflow = Math.abs(rows.filter(isSpendTransaction).reduce((sum, txn) => sum + txn.amount, 0));
    return Promise.resolve({
      ...SUMMARY,
      periodLabel: params.label ?? SUMMARY.periodLabel,
      total: outflow,
      inflow,
      outflow,
      net: inflow - outflow,
    });
  }
  const query = new URLSearchParams();
  if (params.period) query.set('period', params.period);
  if (params.from) query.set('from', params.from);
  if (params.to) query.set('to', params.to);
  if (params.label) query.set('label', params.label);
  if (params.biz && params.biz !== 'all') query.set('biz', params.biz);
  if (params.accountIds?.length) query.set('accounts', params.accountIds.join(','));
  if (params.bucketPreset) query.set('bucketPreset', params.bucketPreset);
  return http<ApiSpendSummary>(`/summary?${query.toString()}`).then(mapSummary);
}

export interface BreakdownBucket {
  /** Business key, account id, or receipt status depending on the breakdown. */
  key: string;
  label: string;
  color?: string;
  cents: number;
  count: number;
}

export interface SummaryBreakdowns {
  /** Every matching transaction (any direction) — "of N" counts. */
  rows: number;
  /** Operating spend (same definition as the hero outflow). */
  spendCents: number;
  spendCount: number;
  byBusiness: BreakdownBucket[];
  byAccount: BreakdownBucket[];
  byReceipt: BreakdownBucket[];
}

export interface SummaryBreakdownParams {
  from: string;
  to: string;
  biz?: BusinessId | 'all';
  accountIds?: string[];
  q?: string;
}

/**
 * GET /api/summary/breakdowns — server-side spend by business / account / receipt status
 * for the dashboard tiles, so they agree with the hero totals instead of summing a
 * capped page of transactions in the browser.
 */
export function getSummaryBreakdowns(params: SummaryBreakdownParams): Promise<SummaryBreakdowns> {
  if (useMockApi) {
    const q = params.q?.toLowerCase();
    const rows = visibleMockTransactions(TRANSACTIONS, params.accountIds)
      .filter((txn) => !params.biz || params.biz === 'all' || txn.biz === params.biz)
      .filter((txn) => txn.date >= params.from && txn.date <= params.to)
      .filter((txn) => !q || [txn.merchant, txn.cat, txn.src, txn.note ?? ''].some((value) => value.toLowerCase().includes(q)));
    return Promise.resolve(summarizeBreakdowns(rows, BUSINESSES));
  }
  const query = new URLSearchParams({ from: params.from, to: params.to });
  if (params.biz && params.biz !== 'all') query.set('biz', params.biz);
  if (params.accountIds?.length) query.set('accounts', params.accountIds.join(','));
  if (params.q) query.set('q', params.q);
  return http<SummaryBreakdowns>(`/summary/breakdowns?${query.toString()}`);
}

/** Client-side mirror of the server fold, used by mock mode. */
export function summarizeBreakdowns(rows: Transaction[], businesses: Business[]): SummaryBreakdowns {
  const businessById = new Map(businesses.map((business) => [business.id, business]));
  const byBusiness = new Map<string, BreakdownBucket>();
  const byAccount = new Map<string, BreakdownBucket>();
  const byReceipt = new Map<string, BreakdownBucket>();
  const add = (map: Map<string, BreakdownBucket>, key: string, label: string, cents: number, color?: string) => {
    const bucket = map.get(key) ?? { key, label, color, cents: 0, count: 0 };
    bucket.cents += cents;
    bucket.count += 1;
    map.set(key, bucket);
  };
  let spendCents = 0;
  let spendCount = 0;
  for (const txn of rows) {
    if (!isSpendTransaction(txn)) continue;
    const cents = Math.abs(Math.round(txn.amount * 100));
    spendCents += cents;
    spendCount += 1;
    const business = businessById.get(txn.biz);
    add(byBusiness, txn.biz, business?.name ?? txn.biz, cents, business?.color);
    if (txn.accountId) add(byAccount, txn.accountId, txn.accountId, cents);
    add(byReceipt, txn.receipt, txn.receipt, cents);
  }
  const sorted = (map: Map<string, BreakdownBucket>) => [...map.values()].sort((a, b) => b.cents - a.cents);
  return {
    rows: rows.length,
    spendCents,
    spendCount,
    byBusiness: sorted(byBusiness),
    byAccount: sorted(byAccount),
    byReceipt: sorted(byReceipt),
  };
}

export interface DailyMovementParams {
  from: string;
  to: string;
  biz?: BusinessId | 'all';
  accountIds?: string[];
}

/**
 * GET /api/summary/daily — operating outflow / inflow per day (sparse: quiet days omitted).
 * Feeds the Home spend-pace chart and its same-day-last-month KPIs.
 */
export function getDailyMovement(params: DailyMovementParams): Promise<DailyMovement[]> {
  if (useMockApi) {
    const byDate = new Map<string, DailyMovement>();
    visibleMockTransactions(TRANSACTIONS, params.accountIds)
      .filter((txn) => !params.biz || params.biz === 'all' || txn.biz === params.biz)
      .filter((txn) => txn.date >= params.from && txn.date <= params.to)
      .forEach((txn) => {
        const entry = byDate.get(txn.date) ?? { date: txn.date, outflowCents: 0, inflowCents: 0 };
        const cents = Math.round(txn.amount * 100);
        if (isSpendTransaction(txn)) entry.outflowCents += Math.abs(cents);
        else if (cents > 0 && !isTransferTransaction(txn)) entry.inflowCents += cents;
        byDate.set(txn.date, entry);
      });
    return Promise.resolve([...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)));
  }
  const query = new URLSearchParams({ from: params.from, to: params.to });
  if (params.biz && params.biz !== 'all') query.set('biz', params.biz);
  if (params.accountIds?.length) query.set('accounts', params.accountIds.join(','));
  return http<{ days: DailyMovement[] }>(`/summary/daily?${query.toString()}`).then((body) => body.days);
}
