import { describe, expect, it } from 'vitest';
import type { ReviewGroup } from '@/types/automation';
import {
  automationLineParts,
  groupReviewItemsLocally,
  itemsForGroup,
  reviewGroupActions,
  reviewGroupHeadline,
  reviewGroupKind,
  reviewGroupReason,
  timeAgo,
  type AnyReviewItem,
} from './reviewGroups';

function group(overrides: Partial<ReviewGroup> = {}): ReviewGroup {
  return {
    groupKey: 'b|gusto|wages',
    businessId: 'b',
    biz: 'draft-sharks',
    merchant: 'Gusto',
    normalizedMerchant: 'gusto',
    proposedCategoryId: 'wages',
    proposedCategoryName: 'Wages',
    types: ['ai_category_suggestion'],
    itemIds: ['i1', 'i2'],
    itemCount: 2,
    transactionCount: 12,
    totalCents: 421_000,
    confidence: { min: 0.74, max: 0.86 },
    sampleTransactions: [],
    learnsRule: true,
    oldestCreatedAt: '2026-09-01T00:00:00.000Z',
    newestCreatedAt: '2026-09-20T00:00:00.000Z',
    ...overrides,
  };
}

function item(overrides: Partial<AnyReviewItem> & { payload?: AnyReviewItem['payload'] } = {}): AnyReviewItem {
  return {
    id: 'i1',
    businessId: 'b',
    biz: 'draft-sharks',
    type: 'ai_category_suggestion',
    status: 'open',
    title: 't',
    detail: 'd',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    payload: {},
    ...overrides,
  };
}

describe('reviewGroupHeadline', () => {
  it('shows the transaction count, merchant and target', () => {
    expect(reviewGroupHeadline(group())).toBe('12 × Gusto → Wages');
  });
  it('drops the count for a single transaction and falls back to items', () => {
    expect(reviewGroupHeadline(group({ transactionCount: 1 }))).toBe('Gusto → Wages');
    expect(reviewGroupHeadline(group({ transactionCount: 0, itemCount: 3 }))).toBe('3 × Gusto → Wages');
    expect(reviewGroupHeadline(group({ transactionCount: 1, proposedCategoryName: null }))).toBe('Gusto → Uncategorized');
  });
});

describe('reviewGroupKind / actions', () => {
  it('lets the most demanding type win', () => {
    expect(reviewGroupKind(group({ types: ['ai_category_suggestion', 'rule_conflict_review'] }))).toBe('conflict');
    expect(reviewGroupKind(group({ types: ['ai_category_suggestion', 'external_category_suggestion'] }))).toBe('external');
    expect(reviewGroupKind(group({ types: ['learn_rule_prompt'] }))).toBe('learn');
    expect(reviewGroupKind(group())).toBe('ai');
  });
  it('words conflicts as switch/keep rule', () => {
    expect(reviewGroupActions(group({ types: ['rule_conflict_review'] }))).toEqual({ accept: 'Switch rule', dismiss: 'Keep rule' });
    expect(reviewGroupActions(group())).toEqual({ accept: 'Accept all', dismiss: 'Dismiss' });
    expect(reviewGroupActions(group({ itemCount: 1 })).accept).toBe('Accept');
  });
});

describe('reviewGroupReason', () => {
  it('explains a learned-rule contradiction', () => {
    const g = group({ merchant: 'Adobe', proposedCategoryName: 'Software', types: ['rule_conflict_review'] });
    const conflict = item({
      type: 'rule_conflict_review',
      payload: { currentCategoryName: 'Office Expense', evidence: { kind: 'learned_rule_contradiction' } },
    });
    expect(reviewGroupReason(g, [conflict])).toBe('You changed Adobe to Software, but a learned rule says Office Expense');
  });
  it('names QuickBooks for external suggestions', () => {
    const g = group({ proposedCategoryName: 'Contract Labor', types: ['external_category_suggestion'] });
    const external = item({ type: 'external_category_suggestion', payload: { evidence: { signalSource: 'quickbooks' } } });
    expect(reviewGroupReason(g, [external])).toBe('QuickBooks says Contract Labor');
    expect(reviewGroupReason(g)).toBe('QuickBooks says Contract Labor');
  });
  it('shows the AI confidence range', () => {
    expect(reviewGroupReason(group())).toBe('AI suggestion · 74–86% sure');
    expect(reviewGroupReason(group({ confidence: { min: 0.8, max: 0.8 } }))).toBe('AI suggestion · 80% sure');
    expect(reviewGroupReason(group({ confidence: null }))).toBe('AI suggestion');
  });
});

describe('itemsForGroup', () => {
  it('keeps group order and skips items not loaded', () => {
    const rows = [item({ id: 'i2' }), item({ id: 'x' })];
    expect(itemsForGroup(group({ itemIds: ['i1', 'i2'] }), rows).map((row) => row.id)).toEqual(['i2']);
  });
});

describe('groupReviewItemsLocally', () => {
  it('groups per business, merchant and proposed category, summing distinct transactions', () => {
    const txns = new Map([
      ['t1', { id: 't1', date: '2026-09-01', merchant: 'Gusto', amountCents: -100_00, categoryId: null, categoryName: null }],
      ['t2', { id: 't2', date: '2026-09-08', merchant: 'Gusto', amountCents: -50_00, categoryId: null, categoryName: null }],
    ]);
    const groups = groupReviewItemsLocally([
      item({ id: 'a', payload: { merchant: 'Gusto', proposedCategoryId: 'wages', proposedCategoryName: 'Wages', transactionIds: ['t1'], confidence: 0.7 } }),
      item({ id: 'b', payload: { merchant: 'GUSTO', proposedCategoryId: 'wages', proposedCategoryName: 'Wages', transactionIds: ['t2', 't1'], confidence: 0.9 } }),
      item({ id: 'c', payload: { merchant: 'Gusto', proposedCategoryId: 'payroll', proposedCategoryName: 'Payroll' } }),
    ], txns);
    expect(groups).toHaveLength(2);
    const [wages] = groups;
    expect(wages.itemIds).toEqual(['a', 'b']);
    expect(wages.transactionCount).toBe(2);
    expect(wages.totalCents).toBe(150_00);
    expect(wages.confidence).toEqual({ min: 0.7, max: 0.9 });
    expect(wages.sampleTransactions.map((row) => row.id)).toEqual(['t2', 't1']);
  });
});

describe('automationLineParts', () => {
  it('leaves out zero parts and pluralizes', () => {
    expect(automationLineParts({ handledAutomatically: 23, rulesAutoLearned: 1, rulesLearnedFromReview: 1 }))
      .toEqual({ handled: '23 handled automatically', learned: '2 rules learned', learnedCount: 2 });
    expect(automationLineParts({ handledAutomatically: 0, rulesAutoLearned: 1, rulesLearnedFromReview: 0 }))
      .toEqual({ handled: null, learned: '1 rule learned', learnedCount: 1 });
  });
});

describe('timeAgo', () => {
  const now = Date.parse('2026-09-27T12:00:00.000Z');
  it('buckets minutes, hours and days', () => {
    expect(timeAgo('2026-09-27T11:59:50.000Z', now)).toBe('just now');
    expect(timeAgo('2026-09-27T11:30:00.000Z', now)).toBe('30m ago');
    expect(timeAgo('2026-09-27T09:00:00.000Z', now)).toBe('3h ago');
    expect(timeAgo('2026-09-25T12:00:00.000Z', now)).toBe('2d ago');
    expect(timeAgo(null, now)).toBe('—');
  });
});
