import type { BusinessId, SpendSummary } from '@/types/domain';
import { isSpendTransaction } from '@/lib/calc';
import { http, useMockApi } from './client';
import { mapSummary, type ApiSpendSummary } from './mapper';
import { SUMMARY, TRANSACTIONS, visibleMockTransactions } from './mocks';

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
} = {}): Promise<SpendSummary> {
  if (useMockApi) {
    const visibleTransactions = visibleMockTransactions(TRANSACTIONS, params.accountIds);
    const rows = visibleTransactions
      .filter((txn) => !params.biz || params.biz === 'all' || txn.biz === params.biz)
      .filter((txn) => !params.from || txn.date >= params.from)
      .filter((txn) => !params.to || txn.date <= params.to);
    return Promise.resolve({
      ...SUMMARY,
      periodLabel: params.label ?? SUMMARY.periodLabel,
      total: Math.abs(rows.filter(isSpendTransaction).reduce((sum, txn) => sum + txn.amount, 0)),
    });
  }
  const query = new URLSearchParams();
  if (params.period) query.set('period', params.period);
  if (params.from) query.set('from', params.from);
  if (params.to) query.set('to', params.to);
  if (params.label) query.set('label', params.label);
  if (params.biz && params.biz !== 'all') query.set('biz', params.biz);
  if (params.accountIds?.length) query.set('accounts', params.accountIds.join(','));
  return http<ApiSpendSummary>(`/summary?${query.toString()}`).then(mapSummary);
}
