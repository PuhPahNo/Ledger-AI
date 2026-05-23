import type { Business } from '@/types/domain';
import { http, useMockApi } from './client';
import { BUSINESSES } from './mocks';

/**
 * GET /api/businesses
 * Returns every business the signed-in user can see.
 */
export function listBusinesses(): Promise<Business[]> {
  if (useMockApi) return Promise.resolve(BUSINESSES);
  return http<Business[]>('/businesses');
}
