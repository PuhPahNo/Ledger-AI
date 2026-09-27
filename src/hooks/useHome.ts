import { useEffect, useState } from 'react';
import {
  getDailyMovement,
  listAccounts,
  listBusinesses,
  listCategoryComparisons,
  listTransactions,
} from '@/api';
import type { Account, Business, CategoryComparison, Transaction } from '@/types/domain';
import { todayIso } from '@/lib/dates';
import {
  alignedPrior,
  buildSpendPace,
  buildTimeWindow,
  elapsedEnd,
  priorPeriod,
  type SpendPace,
  type TimePreset,
  type TimeWindow,
} from '@/lib/periods';

export interface HomeParams {
  business: string;
  /** YYYY-MM the preset is anchored on. */
  month: string;
  preset: TimePreset;
  refreshKey?: number;
}

export interface HomeData {
  businesses: Business[];
  window: TimeWindow;
  prior: { from: string; to: string };
  /** Last elapsed day of the window (null when the window is in the future). */
  asOf: string | null;
  pace: SpendPace;
  /** Category spend to date vs the prior window at the same point, largest first. */
  categories: CategoryComparison[];
  /** The latest few transactions in the window (activity list only — never summed). */
  recent: Transaction[];
  accounts: Account[];
}

interface HomeState {
  data: HomeData | null;
  loading: boolean;
  error: Error | null;
}

const RECENT_LIMIT = 8;
const cache = new Map<string, { data: HomeData; refreshKey: number }>();

export function clearHomeCache(): void {
  cache.clear();
}

function cacheKey(params: HomeParams): string {
  return JSON.stringify([params.business, params.month, params.preset, todayIso()]);
}

async function fetchHome(params: HomeParams): Promise<HomeData> {
  const today = todayIso();
  const window = buildTimeWindow(params.month, params.preset);
  const prior = priorPeriod(window.from, window.to);
  const asOf = elapsedEnd(window.from, window.to, today);
  const biz = params.business;

  const [businesses, daily, recent, accounts] = await Promise.all([
    listBusinesses(),
    getDailyMovement({ from: prior.from, to: asOf ?? prior.to, biz }),
    asOf
      ? listTransactions({ biz, from: window.from, to: asOf, limit: RECENT_LIMIT, sort: 'date', dir: 'desc' })
      : Promise.resolve([]),
    listAccounts({ biz }),
  ]);
  const pace = buildSpendPace({ window, prior, today, rows: daily });
  const comparePrior = alignedPrior(prior, pace.elapsedDays);
  const categories = asOf && comparePrior
    ? await listCategoryComparisons({
      from: window.from,
      to: asOf,
      prevFrom: comparePrior.from,
      prevTo: comparePrior.to,
      biz,
      limit: 20,
    }).catch(() => [])
    : [];

  return { businesses, window, prior, asOf, pace, categories, recent, accounts };
}

/** Everything Home shows below "Needs you", for one business + time window. */
export function useHome(params: HomeParams): HomeState {
  const key = cacheKey(params);
  const refreshKey = params.refreshKey ?? 0;
  const [state, setState] = useState<HomeState>(() => {
    const cached = cache.get(key);
    return { data: cached?.data ?? null, loading: !cached, error: null };
  });

  useEffect(() => {
    let cancelled = false;
    const cached = cache.get(key);
    if (cached) {
      setState({ data: cached.data, loading: false, error: null });
      if (cached.refreshKey >= refreshKey) return () => { cancelled = true; };
    } else {
      // Keep showing the previous window's numbers while the next one loads.
      setState((current) => ({ ...current, loading: true, error: null }));
    }
    fetchHome(params)
      .then((data) => {
        if (cancelled) return;
        cache.set(key, { data, refreshKey });
        setState({ data, loading: false, error: null });
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setState((current) => ({ data: current.data, loading: false, error }));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refreshKey]);

  return state;
}
