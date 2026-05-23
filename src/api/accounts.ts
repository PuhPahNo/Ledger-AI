import type { Account, BusinessId } from '@/types/domain';
import { http, useMockApi } from './client';
import { ACCOUNTS } from './mocks';

export function listAccounts(params: { biz?: BusinessId | 'all' } = {}): Promise<Account[]> {
  if (useMockApi) {
    return Promise.resolve(params.biz && params.biz !== 'all' ? ACCOUNTS.filter((a) => a.biz === params.biz) : ACCOUNTS);
  }
  const query = new URLSearchParams();
  if (params.biz && params.biz !== 'all') query.set('biz', params.biz);
  return http<Account[]>(`/accounts?${query.toString()}`);
}

export function updateAccountBusiness(accountId: string, businessId: string | null, applyToExisting = false): Promise<Account> {
  if (useMockApi) return Promise.resolve(ACCOUNTS.find((a) => a.id === accountId) ?? ACCOUNTS[0]);
  return http<Account>(`/accounts/${accountId}/business`, {
    method: 'PATCH',
    body: JSON.stringify({ businessId, applyToExisting }),
  });
}

export function updateAccountEnabled(accountId: string, enabled: boolean): Promise<Account> {
  if (useMockApi) return Promise.resolve(ACCOUNTS.find((a) => a.id === accountId) ?? ACCOUNTS[0]);
  return http<Account>(`/accounts/${accountId}/enabled`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  });
}
