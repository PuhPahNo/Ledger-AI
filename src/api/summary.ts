import type { SpendSummary } from '@/types/domain';
import { http, useMockApi } from './client';
import { mapSummary, type ApiSpendSummary } from './mapper';
import { SUMMARY } from './mocks';

/**
 * GET /api/summary?period=YYYY-MM
 * Returns the dashboard hero summary: this period's outflow, MoM delta,
 * trailing-12 sparkline points, last month and avg month for comparison.
 */
export function getSummary(period?: string): Promise<SpendSummary> {
  if (useMockApi) return Promise.resolve(SUMMARY);
  const q = period ? `?period=${encodeURIComponent(period)}` : '';
  return http<ApiSpendSummary>(`/summary${q}`).then(mapSummary);
}
