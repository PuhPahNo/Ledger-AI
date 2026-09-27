import type { BusinessId, CategoryComparison } from '@/types/domain';
import { isSpendTransaction } from '@/lib/calc';
import { priorPeriod } from '@/lib/periods';
import { monthBounds } from '@/lib/dates';
import { http, useMockApi } from './client';
import { TRANSACTIONS, visibleMockTransactions } from './mocks';

export interface CategoryComparisonParams {
  period?: string;
  from?: string;
  to?: string;
  biz?: BusinessId | 'all';
  basis?: 'month' | 'year';
  q?: string;
  accountIds?: string[];
  /** Explicit comparison window; defaults to the server's prior-period rule. */
  prevFrom?: string;
  prevTo?: string;
  /** Max categories returned (server default 12, max 50). Sorted by current spend. */
  limit?: number;
}

export function listCategoryComparisons(params: CategoryComparisonParams = {}): Promise<CategoryComparison[]> {
  if (useMockApi) return Promise.resolve(mockComparisons(params));
  const query = new URLSearchParams();
  if (params.period) query.set('period', params.period);
  if (params.from) query.set('from', params.from);
  if (params.to) query.set('to', params.to);
  if (params.biz && params.biz !== 'all') query.set('biz', params.biz);
  if (params.basis) query.set('basis', params.basis);
  if (params.q) query.set('q', params.q);
  if (params.accountIds?.length) query.set('accounts', params.accountIds.join(','));
  if (params.prevFrom && params.prevTo) {
    query.set('prevFrom', params.prevFrom);
    query.set('prevTo', params.prevTo);
  }
  if (params.limit) query.set('limit', String(params.limit));
  return http<Array<Omit<CategoryComparison, 'current' | 'previous'> & { currentCents: number; previousCents: number }>>(
    `/insights/category-comparison?${query.toString()}`,
  ).then((rows) => rows.map((row) => ({
    ...row,
    current: row.currentCents / 100,
    previous: row.previousCents / 100,
  })));
}

/** Mock mirror of the server query: real current / previous windows over the fixture set. */
function mockComparisons(params: CategoryComparisonParams): CategoryComparison[] {
  const window = params.from && params.to ? { from: params.from, to: params.to } : monthBounds(params.period ?? params.to?.slice(0, 7) ?? new Date().toISOString().slice(0, 7));
  const prior = params.prevFrom && params.prevTo ? { from: params.prevFrom, to: params.prevTo } : priorPeriod(window.from, window.to);
  const totals = new Map<string, { current: number; previous: number }>();
  visibleMockTransactions(TRANSACTIONS, params.accountIds)
    .filter(isSpendTransaction)
    .filter((txn) => !params.biz || params.biz === 'all' || txn.biz === params.biz)
    .forEach((txn) => {
      const inCurrent = txn.date >= window.from && txn.date <= window.to;
      const inPrior = txn.date >= prior.from && txn.date <= prior.to;
      if (!inCurrent && !inPrior) return;
      const name = txn.cat || 'Uncategorized';
      const entry = totals.get(name) ?? { current: 0, previous: 0 };
      const cents = Math.abs(Math.round(txn.amount * 100));
      if (inCurrent) entry.current += cents;
      if (inPrior) entry.previous += cents;
      totals.set(name, entry);
    });
  return [...totals.entries()]
    .filter(([category]) => !params.q || category.toLowerCase().includes(params.q.toLowerCase()))
    .map(([category, entry]) => ({
      category,
      current: entry.current / 100,
      currentCents: entry.current,
      previous: entry.previous / 100,
      previousCents: entry.previous,
      deltaPct: entry.previous > 0 ? Math.round(((entry.current - entry.previous) / entry.previous) * 100) : 0,
    }))
    .sort((a, b) => b.currentCents - a.currentCents || b.previousCents - a.previousCents)
    .slice(0, params.limit ?? 12);
}
