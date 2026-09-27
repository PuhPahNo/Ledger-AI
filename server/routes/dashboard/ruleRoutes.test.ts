import { describe, expect, it } from 'vitest';
import { ruleHitStats } from './ruleRoutes.js';

describe('ruleHitStats', () => {
  const spend = [
    { businessId: 'b1', merchant: 'Junction', categoryId: 'meals', plaidHints: 'FOOD_AND_DRINK FOOD_AND_DRINK_RESTAURANT', count: 3 },
    { businessId: 'b1', merchant: 'Figma', categoryId: 'misc', plaidHints: 'GENERAL_SERVICES', count: 2 },
    { businessId: 'b2', merchant: 'Cafe Uno', categoryId: 'other', plaidHints: 'FOOD_AND_DRINK', count: 4 },
  ];

  it('counts plaid_category rules against Plaid hints instead of skipping them', () => {
    expect(ruleHitStats(
      { id: 'r1', businessId: null, categoryId: 'meals', matchKind: 'plaid_category', pattern: 'food and drink' },
      spend,
    )).toEqual({ matchCount: 7, mismatchCount: 4 });
  });

  it('weights grouped rows by their transaction count and respects business scope', () => {
    expect(ruleHitStats(
      { id: 'r2', businessId: 'b1', categoryId: 'software', matchKind: 'merchant_exact', pattern: 'figma' },
      spend,
    )).toEqual({ matchCount: 2, mismatchCount: 2 });
  });
});
