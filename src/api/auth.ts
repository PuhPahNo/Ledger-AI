import type { CurrentUser } from '@/types/domain';
import { http, useMockApi } from './client';

export interface LoginResult {
  user?: CurrentUser;
  requiresTotp?: boolean;
}

export function getCurrentUser(): Promise<{ user: CurrentUser | null }> {
  if (useMockApi) {
    return Promise.resolve({
      user: {
        id: 'mock-admin',
        username: 'admin',
        displayName: 'Ledger Admin',
        role: 'admin',
        totpEnabled: false,
      },
    });
  }
  return http<{ user: CurrentUser | null }>('/auth/me');
}

export function login(username: string, password: string, totpCode?: string): Promise<LoginResult> {
  return http<LoginResult>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password, totpCode }),
  });
}

export function logout(): Promise<void> {
  if (useMockApi) return Promise.resolve();
  return http<void>('/auth/logout', { method: 'POST' });
}
