import type { BusinessId, Category } from '@/types/domain';
import { http, useMockApi } from './client';
import { mapCategory, type ApiCategory } from './mapper';
import { CATEGORIES, TRANSACTIONS, visibleMockTransactions } from './mocks';

/**
 * GET /api/categories?period=YYYY-MM
 * Returns categorized spend totals for the period.
 * Backend is responsible for the categorization (rules + ML); UI only displays.
 */
export function listCategories(period?: string, biz?: BusinessId | 'all', q?: string, accountIds: string[] = []): Promise<Category[]> {
  if (useMockApi) {
    const visibleTransactions = visibleMockTransactions(TRANSACTIONS, accountIds);
    let rows = [...CATEGORIES];
    if (biz && biz !== 'all') {
      rows = rows.map((category) => {
        const txns = visibleTransactions.filter((txn) => txn.biz === biz && txn.cat === category.name && txn.amount < 0);
        return {
          ...category,
          amount: Math.abs(txns.reduce((sum, txn) => sum + txn.amount, 0)),
          count: txns.length,
        };
      }).filter((category) => category.count > 0);
    } else if (accountIds.length) {
      rows = rows.map((category) => {
        const txns = visibleTransactions.filter((txn) => txn.cat === category.name && txn.amount < 0);
        return {
          ...category,
          amount: Math.abs(txns.reduce((sum, txn) => sum + txn.amount, 0)),
          count: txns.length,
        };
      }).filter((category) => category.count > 0);
    }
    if (q) rows = rows.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()));
    return Promise.resolve(rows);
  }
  const query = new URLSearchParams();
  if (period) query.set('period', period);
  if (biz && biz !== 'all') query.set('biz', biz);
  if (q) query.set('q', q);
  if (accountIds.length) query.set('accounts', accountIds.join(','));
  return http<ApiCategory[]>(`/categories?${query.toString()}`).then((rows) => rows.map(mapCategory));
}
