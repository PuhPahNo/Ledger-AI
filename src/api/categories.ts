import type { Category } from '@/types/domain';
import { http, useMockApi } from './client';
import { mapCategory, type ApiCategory } from './mapper';
import { CATEGORIES } from './mocks';

/**
 * GET /api/categories?period=YYYY-MM
 * Returns categorized spend totals for the period.
 * Backend is responsible for the categorization (rules + ML); UI only displays.
 */
export function listCategories(period?: string): Promise<Category[]> {
  if (useMockApi) return Promise.resolve(CATEGORIES);
  const q = period ? `?period=${encodeURIComponent(period)}` : '';
  return http<ApiCategory[]>(`/categories${q}`).then((rows) => rows.map(mapCategory));
}
