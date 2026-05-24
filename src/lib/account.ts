import type { Account } from '@/types/domain';

/** Display name for an account — user nickname wins, falls back to the Plaid label. */
export function accountLabel(account: Pick<Account, 'name' | 'nickname'>): string {
  const trimmed = account.nickname?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : account.name;
}
