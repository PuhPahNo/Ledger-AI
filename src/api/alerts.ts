import type { Alert } from '@/types/domain';
import { http, useMockApi } from './client';
import { ALERTS } from './mocks';

/**
 * GET /api/alerts?status=open
 * Returns insight/anomaly flags from the backend: duplicate subscriptions,
 * missing receipts, orphan receipts, spend spikes, etc.
 */
export function listAlerts(): Promise<Alert[]> {
  if (useMockApi) return Promise.resolve(ALERTS);
  return http<Alert[]>('/alerts?status=open');
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
