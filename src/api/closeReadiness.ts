import type { BusinessId, CloseReadiness as BaseCloseReadiness } from '@/types/domain';
import { singleMonthOfRange } from '@/lib/dates';
import { http, useMockApi } from './client';

/**
 * Month-close state. Sign-off is keyed by business + calendar month, so it applies to any
 * range inside that month and doesn't vanish when "to" moves forward.
 */
export interface CloseReadiness extends BaseCloseReadiness {
  /** YYYY-MM the viewed range belongs to; null when the range spans several months. */
  closeMonth?: string | null;
  /** Transactions in the signed-off month created or edited after sign-off. */
  changedSinceSignOff?: number;
}

/** Mock-mode sign-offs, keyed like the server: `<biz>:<YYYY-MM>`. */
const mockSignoffs = new Map<string, string>();

export interface CloseReadinessParams {
  from: string;
  to: string;
  biz?: BusinessId | 'all';
  accountIds?: string[];
}

export function getCloseReadiness(params: CloseReadinessParams): Promise<CloseReadiness> {
  if (useMockApi) return Promise.resolve(mockCloseReadiness(params));
  const query = new URLSearchParams();
  query.set('from', params.from);
  query.set('to', params.to);
  if (params.biz && params.biz !== 'all') query.set('biz', params.biz);
  if (params.accountIds?.length) query.set('accounts', params.accountIds.join(','));
  return http<CloseReadiness>(`/close-readiness?${query.toString()}`);
}

export function signOffClosePeriod(params: CloseReadinessParams): Promise<CloseReadiness> {
  if (useMockApi) {
    const month = singleMonthOfRange(params.from, params.to);
    if (!month) return Promise.reject(new Error('Month close covers one calendar month — pick a range inside a single month.'));
    mockSignoffs.set(`${params.biz ?? 'all'}:${month}`, new Date().toISOString());
    return Promise.resolve(mockCloseReadiness(params));
  }
  return http<CloseReadiness>('/close-readiness/sign-off', {
    method: 'POST',
    body: JSON.stringify({
      from: params.from,
      to: params.to,
      biz: params.biz,
      accounts: params.accountIds ?? [],
    }),
  });
}

function mockCloseReadiness(params: CloseReadinessParams): CloseReadiness {
  const closeMonth = singleMonthOfRange(params.from, params.to);
  const signedOffAt = closeMonth ? mockSignoffs.get(`${params.biz ?? 'all'}:${closeMonth}`) ?? null : null;
  if (signedOffAt) {
    return {
      from: params.from,
      to: params.to,
      biz: params.biz ?? 'all',
      closeMonth,
      signedOff: true,
      signedOffAt,
      changedSinceSignOff: 0,
      canSignOff: false,
      items: [],
    };
  }
  return {
    from: params.from,
    to: params.to,
    biz: params.biz ?? 'all',
    closeMonth,
    signedOff: false,
    signedOffAt: null,
    changedSinceSignOff: 0,
    canSignOff: false,
    items: [
      {
        id: 'missing-receipts',
        label: '3 missing receipts',
        detail: '$1,280 of operating outflow still needs documentation.',
        severity: 'blocker',
        count: 3,
        cents: 128000,
        actionView: 'transactions',
        filters: { receipts: ['missing'], direction: 'operating-outflow' },
      },
      {
        id: 'transfers',
        label: '2 transfers to audit',
        detail: 'Transfer movement is visible for review.',
        severity: 'review',
        count: 2,
        actionView: 'transactions',
        filters: { direction: 'transfer' },
      },
      {
        id: 'export',
        label: 'Queue audit export',
        detail: 'Queue an audit export after blockers are clear.',
        severity: 'ready',
        count: 0,
        actionView: 'admin',
        filters: { tab: 'exports' },
      },
    ],
  };
}
