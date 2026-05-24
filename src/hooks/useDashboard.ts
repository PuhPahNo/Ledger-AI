import { useEffect, useState } from 'react';
import {
  listAlerts,
  listBusinesses,
  listCategories,
  listConnections,
  listTransactions,
  getSummary,
  listAccounts,
  listCategoryComparisons,
} from '@/api';
import type {
  Alert,
  Business,
  Category,
  CategoryComparison,
  Connection,
  Account,
  SpendSummary,
  Transaction,
} from '@/types/domain';

export interface DashboardData {
  businesses: Business[];
  transactions: Transaction[];
  categories: Category[];
  categoryComparisons: CategoryComparison[];
  connections: Connection[];
  accounts: Account[];
  alerts: Alert[];
  summary: SpendSummary;
}

export interface DashboardState {
  data: DashboardData | null;
  loading: boolean;
  error: Error | null;
}

/**
 * One hook the dashboard view depends on. Behind it, the API layer decides
 * whether to fan out HTTP calls or hand back fixtures — the view doesn't care.
 */
export interface DashboardParams {
  business?: string;
  query?: string;
  period?: string;
  refreshKey?: number;
  comparisonBasis?: 'month' | 'year';
  accountIds?: string[];
}

export function useDashboard(params: DashboardParams = {}): DashboardState {
  const [state, setState] = useState<DashboardState>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    const accountIds = params.accountIds ?? [];
    const window = monthBounds(params.period);

    Promise.all([
      listBusinesses(),
      listTransactions({
        biz: params.business ?? 'all',
        q: params.query || undefined,
        accountIds,
        from: window.from,
        to: window.to,
        limit: 2000,
      }),
      listCategories(params.period, params.business ?? 'all', params.query || undefined, accountIds),
      listCategoryComparisons({
        period: params.period,
        biz: params.business ?? 'all',
        q: params.query || undefined,
        basis: params.comparisonBasis ?? 'month',
        accountIds,
      }).catch(() => []),
      listConnections({ biz: params.business ?? 'all' }),
      listAccounts({ biz: params.business ?? 'all' }),
      listAlerts({ biz: params.business ?? 'all' }),
      getSummary(params.period, params.business ?? 'all', accountIds),
    ])
      .then(([businesses, transactions, categories, categoryComparisons, connections, accounts, alerts, summary]) => {
        if (cancelled) return;
        setState({
          data: { businesses, transactions, categories, categoryComparisons, connections, accounts, alerts, summary },
          loading: false,
          error: null,
        });
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setState({ data: null, loading: false, error });
      });

    return () => {
      cancelled = true;
    };
  }, [params.accountIds?.join(','), params.business, params.comparisonBasis, params.period, params.query, params.refreshKey]);

  return state;
}

function monthBounds(period?: string): { from: string; to: string } {
  const selected = period ?? new Date().toISOString().slice(0, 7);
  const start = new Date(`${selected}-01T00:00:00`);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
  return {
    from: isoDate(start),
    to: isoDate(end),
  };
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
