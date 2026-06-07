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
  listCategorizationReviewItems,
} from '@/api';
import type {
  Alert,
  Business,
  Category,
  CategoryComparison,
  CategorizationReviewItem,
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
  categorizationReviewItems: CategorizationReviewItem[];
  summary: SpendSummary;
}

export interface DashboardState {
  data: DashboardData | null;
  loading: boolean;
  error: Error | null;
}

interface DashboardCacheEntry {
  data: DashboardData;
  refreshKey: number;
}

const dashboardCache = new Map<string, DashboardCacheEntry>();
const dashboardRequests = new Map<string, Promise<DashboardData>>();

export function clearDashboardCache(): void {
  dashboardCache.clear();
  dashboardRequests.clear();
}

/**
 * One hook the dashboard view depends on. Behind it, the API layer decides
 * whether to fan out HTTP calls or hand back fixtures — the view doesn't care.
 */
export interface DashboardParams {
  business?: string;
  query?: string;
  period?: string;
  from?: string;
  to?: string;
  label?: string;
  bucketPreset?: 'month' | 'last3' | 'last12' | 'ytd';
  refreshKey?: number;
  comparisonBasis?: 'month' | 'year';
  accountIds?: string[];
}

export function useDashboard(params: DashboardParams = {}): DashboardState {
  const cacheKey = dashboardCacheKey(params);
  const requestedRefreshKey = params.refreshKey ?? 0;
  const [state, setState] = useState<DashboardState>(() => {
    const cached = dashboardCache.get(cacheKey);
    return {
      data: cached?.data ?? null,
      loading: !cached,
      error: null,
    };
  });

  useEffect(() => {
    let cancelled = false;

    const cached = dashboardCache.get(cacheKey);
    if (cached) {
      setState({ data: cached.data, loading: false, error: null });
      if (cached.refreshKey >= requestedRefreshKey) {
        return () => {
          cancelled = true;
        };
      }
    } else {
      setState((current) => (
        current.data
          ? { ...current, loading: false, error: null }
          : { data: null, loading: true, error: null }
      ));
    }

    const requestKey = `${cacheKey}:${requestedRefreshKey}`;
    const request = dashboardRequests.get(requestKey) ?? fetchDashboardData(params);
    dashboardRequests.set(requestKey, request);

    request
      .then((data) => {
        if (cancelled) return;
        dashboardCache.set(cacheKey, { data, refreshKey: requestedRefreshKey });
        setState({ data, loading: false, error: null });
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setState((current) => (
          current.data
            ? { ...current, loading: false, error: null }
            : { data: null, loading: false, error }
        ));
      })
      .finally(() => {
        if (dashboardRequests.get(requestKey) === request) {
          dashboardRequests.delete(requestKey);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    params.accountIds?.join(','),
    params.business,
    params.comparisonBasis,
    cacheKey,
    params.from,
    params.label,
    params.bucketPreset,
    params.period,
    params.query,
    params.refreshKey,
    params.to,
  ]);

  return state;
}

async function fetchDashboardData(params: DashboardParams): Promise<DashboardData> {
  const accountIds = params.accountIds ?? [];
  const window = params.from && params.to
    ? { from: params.from, to: params.to }
    : monthBounds(params.period);

  const [
    businesses,
    transactions,
    categories,
    categoryComparisons,
    connections,
    accounts,
    alerts,
    categorizationReviewItems,
    summary,
  ] = await Promise.all([
    listBusinesses(),
    listTransactions({
      biz: params.business ?? 'all',
      q: params.query || undefined,
      accountIds,
      from: window.from,
      to: window.to,
      limit: 2000,
    }),
    listCategories({
      period: params.period,
      from: window.from,
      to: window.to,
      biz: params.business ?? 'all',
      q: params.query || undefined,
      accountIds,
    }),
    listCategoryComparisons({
      period: params.period,
      from: window.from,
      to: window.to,
      biz: params.business ?? 'all',
      q: params.query || undefined,
      basis: params.comparisonBasis ?? 'month',
      accountIds,
    }).catch(() => []),
    listConnections({ biz: params.business ?? 'all' }),
    listAccounts({ biz: params.business ?? 'all' }),
    listAlerts({ biz: params.business ?? 'all' }),
    listCategorizationReviewItems({ biz: params.business ?? 'all' }),
    getSummary({
      period: params.period,
      from: window.from,
      to: window.to,
      label: params.label,
      biz: params.business ?? 'all',
      accountIds,
      bucketPreset: params.bucketPreset,
    }),
  ]);

  return {
    businesses,
    transactions,
    categories,
    categoryComparisons,
    connections,
    accounts,
    alerts,
    categorizationReviewItems,
    summary,
  };
}

function dashboardCacheKey(params: DashboardParams): string {
  const accountIds = [...(params.accountIds ?? [])].sort();
  const window = params.from && params.to
    ? { from: params.from, to: params.to }
    : monthBounds(params.period);
  return JSON.stringify({
    accountIds,
    basis: params.comparisonBasis ?? 'month',
    business: params.business ?? 'all',
    from: window.from,
    label: params.label ?? '',
    bucketPreset: params.bucketPreset ?? '',
    period: params.period ?? '',
    query: params.query ?? '',
    to: window.to,
  });
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
