import { describe, expect, it } from 'vitest';
import { groupReviewItems, reviewGroupKey, type GroupableReviewItem, type ReviewGroupTransaction } from './categorizationReviewGroups.js';

const item = (overrides: Partial<GroupableReviewItem> & { id: string }): GroupableReviewItem => ({
  businessId: 'b1',
  businessKey: 'draft-sharks',
  type: 'ai_category_suggestion',
  title: 'Categorize Uber',
  createdAt: new Date('2026-09-20T12:00:00Z'),
  payload: {},
  ...overrides,
});

const txn = (id: string, date: string, amountCents: number): ReviewGroupTransaction => ({
  id, date, merchant: 'UBER *TRIP', amountCents, categoryId: 'uncat', categoryName: 'Uncategorized',
});

describe('groupReviewItems', () => {
  const transactions = new Map([
    ['t1', txn('t1', '2026-09-01', -1000)],
    ['t2', txn('t2', '2026-09-03', -2500)],
    ['t3', txn('t3', '2026-09-02', -400)],
    ['t4', txn('t4', '2026-09-04', -700)],
    ['t5', txn('t5', '2026-09-05', -900)],
  ]);

  it('groups by business, normalized merchant and proposed category with totals and ranges', () => {
    const items = [
      item({ id: 'i1', payload: { merchant: 'UBER *TRIP', transactionId: 't1', proposedCategoryId: 'travel', proposedCategoryName: 'Travel', confidence: 0.6 } }),
      item({ id: 'i2', payload: { merchant: 'Uber Trip', transactionId: 't2', proposedCategoryId: 'travel', proposedCategoryName: 'Travel', confidence: 0.8 }, createdAt: new Date('2026-09-22T00:00:00Z') }),
      item({ id: 'i3', payload: { merchant: 'Uber Trip', transactionIds: ['t3', 't1'], proposedCategoryId: 'travel', confidence: 0.7 } }),
      item({ id: 'i4', payload: { merchant: 'Uber Trip', transactionId: 't4', proposedCategoryId: 'meals', proposedCategoryName: 'Meals' } }),
      item({ id: 'i5', businessId: 'b2', businessKey: 'other', payload: { merchant: 'Uber Trip', transactionId: 't5', proposedCategoryId: 'travel' } }),
    ];
    const groups = groupReviewItems(items, transactions);
    expect(groups).toHaveLength(3);
    const [travel] = groups;
    expect(travel).toEqual({
      groupKey: reviewGroupKey('b1', 'uber trip', 'travel'),
      businessId: 'b1',
      biz: 'draft-sharks',
      merchant: 'UBER *TRIP',
      normalizedMerchant: 'uber trip',
      proposedCategoryId: 'travel',
      proposedCategoryName: 'Travel',
      types: ['ai_category_suggestion'],
      itemIds: ['i1', 'i2', 'i3'],
      itemCount: 3,
      transactionCount: 3,
      totalCents: 3900,
      confidence: { min: 0.6, max: 0.8 },
      sampleTransactions: [transactions.get('t2'), transactions.get('t3'), transactions.get('t1')],
      learnsRule: true,
      oldestCreatedAt: '2026-09-20T12:00:00.000Z',
      newestCreatedAt: '2026-09-22T00:00:00.000Z',
    });
    expect(groups.map((group) => group.groupKey)).toContain(reviewGroupKey('b1', 'uber trip', 'meals'));
    expect(groups.map((group) => group.groupKey)).toContain(reviewGroupKey('b2', 'uber trip', 'travel'));
  });

  it('does not learn a merchant rule from receipt-level evidence', () => {
    const [group] = groupReviewItems([
      item({ id: 'r1', type: 'receipt_category_override', payload: { merchant: 'Amazon', transactionId: 't1', proposedCategoryId: 'office', confidence: 0.9 } }),
    ], transactions);
    expect(group.learnsRule).toBe(false);
    // Receipt/learn prompts aren't machine suggestions, so no AI confidence range.
    expect(group.confidence).toBeNull();
  });

  it('keeps sample size small and tolerates missing transactions', () => {
    const [group] = groupReviewItems([
      item({ id: 'i1', payload: { merchant: 'Uber', transactionIds: ['t1', 't2', 't3', 't4', 'gone'], proposedCategoryId: 'travel' } }),
    ], transactions);
    expect(group.transactionCount).toBe(5);
    expect(group.sampleTransactions).toHaveLength(3);
    expect(group.totalCents).toBe(4600);
  });
});
