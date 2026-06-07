import type { BusinessId, CloseReadiness } from '@/types/domain';
import { http, useMockApi } from './client';

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
    return Promise.resolve({
      ...mockCloseReadiness(params),
      signedOff: true,
      signedOffAt: new Date().toISOString(),
      canSignOff: false,
      items: [],
    });
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
  return {
    from: params.from,
    to: params.to,
    biz: params.biz ?? 'all',
    signedOff: false,
    signedOffAt: null,
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
