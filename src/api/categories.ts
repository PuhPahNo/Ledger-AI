import type { BusinessId, Category } from '@/types/domain';
import { http, useMockApi } from './client';
import { mapCategory, type ApiCategory } from './mapper';
import { CATEGORIES, TRANSACTIONS, visibleMockTransactions } from './mocks';

/**
 * GET /api/categories?period=YYYY-MM
 * Returns categorized spend totals for the period.
 * Backend is responsible for the categorization (rules + ML); UI only displays.
 */
export function listCategories(params: {
  period?: string;
  from?: string;
  to?: string;
  biz?: BusinessId | 'all';
  q?: string;
  accountIds?: string[];
} = {}): Promise<Category[]> {
  if (useMockApi) {
    const visibleTransactions = visibleMockTransactions(TRANSACTIONS, params.accountIds)
      .filter((txn) => !params.from || txn.date >= params.from)
      .filter((txn) => !params.to || txn.date <= params.to);
    let rows = [...CATEGORIES];
    if (params.biz && params.biz !== 'all') {
      rows = rows.map((category) => {
        const txns = visibleTransactions.filter((txn) => txn.biz === params.biz && txn.cat === category.name && txn.amount < 0);
        return {
          ...category,
          amount: Math.abs(txns.reduce((sum, txn) => sum + txn.amount, 0)),
          count: txns.length,
        };
      }).filter((category) => category.count > 0);
    } else if (params.accountIds?.length) {
      rows = rows.map((category) => {
        const txns = visibleTransactions.filter((txn) => txn.cat === category.name && txn.amount < 0);
        return {
          ...category,
          amount: Math.abs(txns.reduce((sum, txn) => sum + txn.amount, 0)),
          count: txns.length,
        };
      }).filter((category) => category.count > 0);
    }
    if (params.q) rows = rows.filter((c) => c.name.toLowerCase().includes(params.q!.toLowerCase()));
    return Promise.resolve(rows);
  }
  const query = new URLSearchParams();
  if (params.period) query.set('period', params.period);
  if (params.from) query.set('from', params.from);
  if (params.to) query.set('to', params.to);
  if (params.biz && params.biz !== 'all') query.set('biz', params.biz);
  if (params.q) query.set('q', params.q);
  if (params.accountIds?.length) query.set('accounts', params.accountIds.join(','));
  return http<ApiCategory[]>(`/categories?${query.toString()}`).then((rows) => rows.map(mapCategory));
}
