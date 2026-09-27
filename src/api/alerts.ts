import type { Alert, AlertKind, BusinessId } from '@/types/domain';
import { http, useMockApi } from './client';
import { ALERTS } from './mocks';

/** An open anomaly alert as served by GET /api/alerts. */
export interface AlertItem extends Alert {
  id: string;
  /** Business key, or null for cross-business alerts (e.g. duplicate subscriptions). */
  biz?: string | null;
  createdAt?: string;
}

/**
 * Alert kinds worth surfacing. Missing receipts and unmatched receipts already have their own
 * Inbox sections with live counts, so those alert kinds would only repeat them.
 */
export const DISPLAYED_ALERT_KINDS: readonly AlertKind[] = ['dup', 'spike'];

const mockDismissed = new Set<string>();

/**
 * GET /api/alerts?status=open
 * Anomaly flags from the nightly insights job: duplicate subscriptions and spend spikes.
 */
export function listAlerts(params: { biz?: BusinessId | 'all' } = {}): Promise<AlertItem[]> {
  if (useMockApi) {
    return Promise.resolve(
      ALERTS
        .filter((alert): alert is AlertItem => Boolean(alert.id))
        .filter((alert) => DISPLAYED_ALERT_KINDS.includes(alert.kind))
        .filter((alert) => !mockDismissed.has(alert.id))
        .filter((alert) => !params.biz || params.biz === 'all' || !alert.biz || alert.biz === params.biz),
    );
  }
  const query = new URLSearchParams({ status: 'open' });
  if (params.biz && params.biz !== 'all') query.set('biz', params.biz);
  return http<AlertItem[]>(`/alerts?${query.toString()}`)
    .then((rows) => rows.filter((alert) => DISPLAYED_ALERT_KINDS.includes(alert.kind)));
}

/**
 * POST /api/alerts/:id/dismiss — dismissed alerts stay dismissed across regenerations.
 */
export function dismissAlert(id: string): Promise<void> {
  if (useMockApi) {
    mockDismissed.add(id);
    return Promise.resolve();
  }
  return http<void>(`/alerts/${id}/dismiss`, { method: 'POST' });
}
