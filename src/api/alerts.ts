import type { Alert, BusinessId } from '@/types/domain';
import { http, useMockApi } from './client';
import { ALERTS } from './mocks';

/**
 * GET /api/alerts?status=open
 * Returns insight/anomaly flags from the backend: duplicate subscriptions,
 * missing receipts, orphan receipts, spend spikes, etc.
 */
export function listAlerts(params: { biz?: BusinessId | 'all' } = {}): Promise<Alert[]> {
  if (useMockApi) return Promise.resolve(params.biz && params.biz !== 'all' ? ALERTS.filter((a) => a.detail.toLowerCase().includes(params.biz!.replace('-', ' '))) : ALERTS);
  const query = new URLSearchParams({ status: 'open' });
  if (params.biz && params.biz !== 'all') query.set('biz', params.biz);
  return http<Alert[]>(`/alerts?${query.toString()}`);
}

/**
 * POST /api/alerts/:id/dismiss
 */
export function dismissAlert(id: string): Promise<void> {
  if (useMockApi) {
    return Promise.reject(new Error('dismissAlert requires the real backend'));
  }
  return http<void>(`/alerts/${id}/dismiss`, { method: 'POST' });
}
