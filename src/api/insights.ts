import type { BusinessId, CategoryComparison } from '@/types/domain';
import { http, useMockApi } from './client';
import { TRANSACTIONS, visibleMockTransactions } from './mocks';

export function listCategoryComparisons(params: {
  period?: string;
  biz?: BusinessId | 'all';
  basis?: 'month' | 'year';
  q?: string;
  accountIds?: string[];
} = {}): Promise<CategoryComparison[]> {
  if (useMockApi) return Promise.resolve(mockComparisons(params));
  const query = new URLSearchParams();
  if (params.period) query.set('period', params.period);
  if (params.biz && params.biz !== 'all') query.set('biz', params.biz);
  if (params.basis) query.set('basis', params.basis);
  if (params.q) query.set('q', params.q);
  if (params.accountIds?.length) query.set('accounts', params.accountIds.join(','));
  return http<Array<Omit<CategoryComparison, 'current' | 'previous'> & { currentCents: number; previousCents: number }>>(
    `/insights/category-comparison?${query.toString()}`,
  ).then((rows) => rows.map((row) => ({
    ...row,
    current: row.currentCents / 100,
    previous: row.previousCents / 100,
  })));
}

function mockComparisons(params: {
  biz?: BusinessId | 'all';
  basis?: 'month' | 'year';
  q?: string;
  accountIds?: string[];
}): CategoryComparison[] {
  const currentMultiplier = params.basis === 'year' ? 7.4 : 1;
  const previousMultiplier = params.basis === 'year' ? 6.6 : 0.72;
  const rows = visibleMockTransactions(TRANSACTIONS, params.accountIds)
    .filter((txn) => txn.amount < 0)
    .filter((txn) => !params.biz || params.biz === 'all' || txn.biz === params.biz)
    .reduce<Record<string, number>>((acc, txn) => {
      acc[txn.cat] = (acc[txn.cat] ?? 0) + Math.abs(txn.amount);
      return acc;
    }, {});

  return Object.entries(rows)
    .filter(([category]) => !params.q || category.toLowerCase().includes(params.q.toLowerCase()))
    .map(([category, current]) => {
      const adjustedCurrent = Math.round(current * currentMultiplier);
      const previous = Math.round(current * previousMultiplier);
      return {
        category,
        current: adjustedCurrent,
        previous,
        deltaPct: previous > 0 ? Math.round(((adjustedCurrent - previous) / previous) * 100) : 0,
      };
    })
    .sort((a, b) => (b.current + b.previous) - (a.current + a.previous));
}
