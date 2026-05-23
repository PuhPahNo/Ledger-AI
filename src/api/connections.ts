import type { Connection } from '@/types/domain';
import { http, useMockApi } from './client';
import { CONNECTIONS } from './mocks';

/**
 * GET /api/connections
 * Returns Plaid (bank/card) and Gmail connections plus their health.
 */
export function listConnections(): Promise<Connection[]> {
  if (useMockApi) return Promise.resolve(CONNECTIONS);
  return http<Connection[]>('/connections');
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
export function exchangePlaidPublicToken(publicToken: string): Promise<Connection> {
  if (useMockApi) {
    return Promise.reject(new Error('exchangePlaidPublicToken requires the real backend'));
  }
  return http<Connection>('/connections/plaid/exchange', {
    method: 'POST',
    body: JSON.stringify({ public_token: publicToken }),
  });
}

/**
 * GET /api/connections/gmail/oauth-url
 * Backend returns a Google OAuth consent URL; frontend redirects to it.
 */
export function getGmailOAuthUrl(): Promise<{ url: string }> {
  if (useMockApi) {
    return Promise.reject(new Error('getGmailOAuthUrl requires the real backend'));
  }
  return http('/connections/gmail/oauth-url');
}
