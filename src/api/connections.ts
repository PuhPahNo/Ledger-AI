import type { BusinessId, Connection } from '@/types/domain';
import { http, useMockApi } from './client';
import { CONNECTIONS } from './mocks';

/**
 * GET /api/connections
 * Returns Plaid (bank/card) and Gmail connections plus their health.
 */
export function listConnections(params: { biz?: BusinessId | 'all' } = {}): Promise<Connection[]> {
  if (useMockApi) {
    return Promise.resolve(params.biz && params.biz !== 'all'
      ? CONNECTIONS.filter((c) => c.biz === params.biz || c.biz === 'all')
      : CONNECTIONS);
  }
  const query = new URLSearchParams();
  if (params.biz && params.biz !== 'all') query.set('biz', params.biz);
  return http<Connection[]>(`/connections?${query.toString()}`);
}

/**
 * POST /api/connections/plaid/link-token
 * Backend exchanges with Plaid and returns a short-lived link token the
 * frontend hands to Plaid Link.
 */
export function createPlaidLinkToken(): Promise<{ link_token: string; expiration: string }> {
  if (useMockApi) {
    return Promise.reject(new Error('createPlaidLinkToken requires the real backend'));
  }
  return http('/connections/plaid/link-token', { method: 'POST' });
}

/**
 * POST /api/connections/plaid/exchange
 * Frontend hands back the public_token Plaid Link produced;
 * backend exchanges for an access_token and persists the item.
 */
export function exchangePlaidPublicToken(publicToken: string, businessId?: string): Promise<Connection> {
  if (useMockApi) {
    return Promise.reject(new Error('exchangePlaidPublicToken requires the real backend'));
  }
  return http<Connection>('/connections/plaid/exchange', {
    method: 'POST',
    body: JSON.stringify({ public_token: publicToken, businessId }),
  });
}

/**
 * GET /api/connections/gmail/oauth-url
 * Backend returns a Google OAuth consent URL; frontend redirects to it.
 */
export function getGmailOAuthUrl(businessId?: string): Promise<{ url: string }> {
  if (useMockApi) {
    return Promise.reject(new Error('getGmailOAuthUrl requires the real backend'));
  }
  const query = new URLSearchParams();
  if (businessId) query.set('businessId', businessId);
  return http(`/connections/gmail/oauth-url?${query.toString()}`);
}

export function syncConnection(connectionId: string): Promise<{ queued: boolean }> {
  if (useMockApi) return Promise.resolve({ queued: true });
  return http<{ queued: boolean }>(`/connections/${connectionId}/sync`, { method: 'POST' });
}

export function backfillConnection(
  connectionId: string,
  months = 12,
): Promise<{ queued: boolean; daysRequested: number; newLinkDaysRequested?: number }> {
  if (useMockApi) return Promise.resolve({ queued: true, daysRequested: months * 31, newLinkDaysRequested: 365 });
  return http<{ queued: boolean; daysRequested: number; newLinkDaysRequested?: number }>(`/connections/${connectionId}/backfill`, {
    method: 'POST',
    body: JSON.stringify({ months }),
  });
}

export function backfillGmailConnection(
  connectionId: string,
  days = 90,
): Promise<{ queued: boolean; daysRequested: number }> {
  if (useMockApi) return Promise.resolve({ queued: true, daysRequested: days });
  return http<{ queued: boolean; daysRequested: number }>(`/connections/${connectionId}/backfill`, {
    method: 'POST',
    body: JSON.stringify({ days }),
  });
}

export function updateConnectionBusiness(connectionId: string, businessId: string | null): Promise<Connection> {
  if (useMockApi) return Promise.resolve(CONNECTIONS.find((c) => c.id === connectionId) ?? CONNECTIONS[0]);
  return http<Connection>(`/connections/${connectionId}/business`, {
    method: 'PATCH',
    body: JSON.stringify({ businessId }),
  });
}

export function updateConnectionLabel(connectionId: string, label: string): Promise<Connection> {
  if (useMockApi) return Promise.resolve({ ...(CONNECTIONS.find((c) => c.id === connectionId) ?? CONNECTIONS[0]), label });
  return http<Connection>(`/connections/${connectionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ label }),
  });
}

export function disconnectConnection(connectionId: string): Promise<void> {
  if (useMockApi) return Promise.resolve();
  return http<void>(`/connections/${connectionId}`, { method: 'DELETE' });
}
