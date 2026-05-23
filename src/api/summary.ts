import type { BusinessId, SpendSummary } from '@/types/domain';
import { http, useMockApi } from './client';
import { mapSummary, type ApiSpendSummary } from './mapper';
import { SUMMARY, TRANSACTIONS, visibleMockTransactions } from './mocks';

/**
 * GET /api/summary?period=YYYY-MM
 * Returns the dashboard hero summary: this period's outflow, MoM delta,
 * trailing-12 sparkline points, last month and avg month for comparison.
 */
export function getSummary(period?: string, biz?: BusinessId | 'all', accountIds: string[] = []): Promise<SpendSummary> {
  if (useMockApi) {
    const visibleTransactions = visibleMockTransactions(TRANSACTIONS, accountIds);
    const rows = biz && biz !== 'all' ? visibleTransactions.filter((txn) => txn.biz === biz) : visibleTransactions;
    return Promise.resolve({
      ...SUMMARY,
      total: Math.abs(rows.filter((txn) => txn.amount < 0).reduce((sum, txn) => sum + txn.amount, 0)),
    });
  }
  const query = new URLSearchParams();
  if (period) query.set('period', period);
  if (biz && biz !== 'all') query.set('biz', biz);
  if (accountIds.length) query.set('accounts', accountIds.join(','));
  return http<ApiSpendSummary>(`/summary?${query.toString()}`).then(mapSummary);
}
