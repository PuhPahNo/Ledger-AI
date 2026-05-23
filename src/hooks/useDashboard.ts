import { useEffect, useState } from 'react';
import {
  listAlerts,
  listBusinesses,
  listCategories,
  listConnections,
  listTransactions,
  getSummary,
} from '@/api';
import type {
  Alert,
  Business,
  Category,
  Connection,
  SpendSummary,
  Transaction,
} from '@/types/domain';

export interface DashboardData {
  businesses: Business[];
  transactions: Transaction[];
  categories: Category[];
  connections: Connection[];
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
export function useDashboard(): DashboardState {
  const [state, setState] = useState<DashboardState>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      listBusinesses(),
      listTransactions(),
      listCategories(),
      listConnections(),
      listAlerts(),
      getSummary(),
    ])
      .then(([businesses, transactions, categories, connections, alerts, summary]) => {
        if (cancelled) return;
        setState({
          data: { businesses, transactions, categories, connections, alerts, summary },
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
  }, []);

  return state;
}
