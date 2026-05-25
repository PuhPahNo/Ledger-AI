import type { BusinessId, CategorizationReviewItem } from '@/types/domain';
import { http, useMockApi } from './client';

export function listCategorizationReviewItems(params: {
  biz?: BusinessId | 'all';
  status?: CategorizationReviewItem['status'];
} = {}): Promise<CategorizationReviewItem[]> {
  if (useMockApi) return Promise.resolve([]);
  const query = new URLSearchParams({ status: params.status ?? 'open' });
  if (params.biz && params.biz !== 'all') query.set('biz', params.biz);
  return http<CategorizationReviewItem[]>(`/categorization/review-items?${query.toString()}`);
}

export function resolveCategorizationReviewItem(
  id: string,
  action: 'accept' | 'dismiss',
): Promise<{ item: CategorizationReviewItem; appliedCount: number; conflictCount: number }> {
  if (useMockApi) {
    return Promise.resolve({
      item: {
        id,
        businessId: 'mock',
        biz: 'all',
        type: 'learn_rule_prompt',
        status: action === 'accept' ? 'accepted' : 'dismissed',
        title: 'Resolved',
        detail: '',
        payload: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      appliedCount: 0,
      conflictCount: 0,
    });
  }
  return http(`/categorization/review-items/${id}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ action }),
  });
}
