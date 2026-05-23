import { useEffect, useState } from 'react';
import {
  listAlerts,
  listBusinesses,
  listCategories,
  listConnections,
  listTransactions,
  getSummary,
  listAccounts,
} from '@/api';
import type {
  Alert,
  Business,
  Category,
  Connection,
  Account,
  SpendSummary,
  Transaction,
} from '@/types/domain';

export interface DashboardData {
  businesses: Business[];
  transactions: Transaction[];
  categories: Category[];
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
}

export function useDashboard(params: DashboardParams = {}): DashboardState {
  const [state, setState] = useState<DashboardState>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      listBusinesses(),
      listTransactions({ biz: params.business ?? 'all', q: params.query || undefined }),
      listCategories(params.period, params.business ?? 'all', params.query || undefined),
      listConnections({ biz: params.business ?? 'all' }),
      listAccounts({ biz: params.business ?? 'all' }),
      listAlerts({ biz: params.business ?? 'all' }),
      getSummary(params.period, params.business ?? 'all'),
    ])
      .then(([businesses, transactions, categories, connections, accounts, alerts, summary]) => {
        if (cancelled) return;
        setState({
          data: { businesses, transactions, categories, connections, accounts, alerts, summary },
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
  }, [params.business, params.period, params.query, params.refreshKey]);

  return state;
}
