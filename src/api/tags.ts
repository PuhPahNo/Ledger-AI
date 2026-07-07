import type { Tag, TagRule, TagRuleMatchKind, TagTrendSeries, TransactionTag } from '@/types/domain';
import { http, useMockApi } from './client';
import { TAGS, TAG_RULES, TRANSACTIONS, mockTagTrends } from './mocks';

/** GET /api/tags — every custom tag with live usage stats. */
export function listTags(): Promise<Tag[]> {
  if (useMockApi) return Promise.resolve([...TAGS]);
  return http<{ tags: Tag[] }>('/tags').then((body) => body.tags);
}

/** POST /api/tags */
export function createTag(body: { name: string; color: string }): Promise<Tag> {
  if (useMockApi) {
    const tag: Tag = { id: `tag-${TAGS.length + 1}`, active: true, txnCount: 0, totalCents: 0, ...body };
    TAGS.push(tag);
    return Promise.resolve(tag);
  }
  return http<Tag>('/tags', { method: 'POST', body: JSON.stringify(body) });
}

/** PATCH /api/tags/:id */
export function updateTag(
  tagId: string,
  body: { name?: string; color?: string; active?: boolean },
): Promise<Tag> {
  if (useMockApi) {
    const tag = TAGS.find((item) => item.id === tagId) ?? TAGS[0];
    Object.assign(tag, body);
    return Promise.resolve(tag);
  }
  return http<Tag>(`/tags/${tagId}`, { method: 'PATCH', body: JSON.stringify(body) });
}

/** DELETE /api/tags/:id — removes the tag everywhere (assignments cascade). */
export function deleteTag(tagId: string): Promise<void> {
  if (useMockApi) {
    const index = TAGS.findIndex((item) => item.id === tagId);
    if (index >= 0) TAGS.splice(index, 1);
    return Promise.resolve();
  }
  return http<void>(`/tags/${tagId}`, { method: 'DELETE' });
}

/** GET /api/tags/:id/rules */
export function listTagRules(tagId: string): Promise<TagRule[]> {
  if (useMockApi) return Promise.resolve(TAG_RULES.filter((rule) => rule.tagId === tagId));
  return http<{ rules: TagRule[] }>(`/tags/${tagId}/rules`).then((body) => body.rules);
}

/** POST /api/tags/:id/rules — add an auto-apply rule; history is untouched until "apply". */
export function createTagRule(
  tagId: string,
  body: { matchKind: TagRuleMatchKind; pattern: string },
): Promise<TagRule> {
  if (useMockApi) {
    const rule: TagRule = { id: `tag-rule-${TAG_RULES.length + 1}`, tagId, ...body };
    TAG_RULES.push(rule);
    return Promise.resolve(rule);
  }
  return http<TagRule>(`/tags/${tagId}/rules`, { method: 'POST', body: JSON.stringify(body) });
}

/** DELETE /api/tag-rules/:id */
export function deleteTagRule(ruleId: string): Promise<void> {
  if (useMockApi) {
    const index = TAG_RULES.findIndex((rule) => rule.id === ruleId);
    if (index >= 0) TAG_RULES.splice(index, 1);
    return Promise.resolve();
  }
  return http<void>(`/tag-rules/${ruleId}`, { method: 'DELETE' });
}

/** POST /api/tags/:id/apply — run the tag's rules across all existing transactions. */
export function applyTagToHistory(tagId: string): Promise<{ tagged: number }> {
  if (useMockApi) return Promise.resolve({ tagged: 0 });
  return http<{ tagged: number }>(`/tags/${tagId}/apply`, { method: 'POST' });
}

/** POST /api/transactions/:id/tags — manual tag; returns the transaction's full tag list. */
export function addTransactionTag(transactionId: string, tagId: string): Promise<{ tags: TransactionTag[] }> {
  if (useMockApi) {
    const row = TRANSACTIONS.find((txn) => txn.id === transactionId);
    const tag = TAGS.find((item) => item.id === tagId);
    if (row && tag && !row.tags?.some((item) => item.id === tagId)) {
      row.tags = [...(row.tags ?? []), { id: tag.id, name: tag.name, color: tag.color, source: 'manual' }];
    }
    return Promise.resolve({ tags: row?.tags ?? [] });
  }
  return http<{ tags: TransactionTag[] }>(`/transactions/${transactionId}/tags`, {
    method: 'POST',
    body: JSON.stringify({ tagId }),
  });
}

/** DELETE /api/transactions/:id/tags/:tagId */
export function removeTransactionTag(transactionId: string, tagId: string): Promise<void> {
  if (useMockApi) {
    const row = TRANSACTIONS.find((txn) => txn.id === transactionId);
    if (row?.tags) row.tags = row.tags.filter((item) => item.id !== tagId);
    return Promise.resolve();
  }
  return http<void>(`/transactions/${transactionId}/tags/${tagId}`, { method: 'DELETE' });
}

/**
 * GET /api/tags/trends — monthly outflow per tag for charting.
 * Omitting tagIds means "all active tags"; default range is the trailing 12 months.
 */
export function getTagTrends(params: { tagIds?: string[]; from?: string; to?: string } = {}): Promise<TagTrendSeries[]> {
  if (useMockApi) {
    const ids = params.tagIds?.length ? params.tagIds : TAGS.map((tag) => tag.id);
    return Promise.resolve(mockTagTrends(ids));
  }
  const query = new URLSearchParams();
  if (params.tagIds?.length) query.set('tags', params.tagIds.join(','));
  if (params.from) query.set('from', params.from);
  if (params.to) query.set('to', params.to);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return http<{ series: TagTrendSeries[] }>(`/tags/trends${suffix}`).then((body) => body.series);
}
