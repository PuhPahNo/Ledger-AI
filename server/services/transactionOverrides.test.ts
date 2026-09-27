import { describe, expect, it } from 'vitest';
import {
  manualCategoryFeedbackKey,
  normalizeTransactionOverride,
  shouldLearnFromManualCategory,
} from './transactionOverrides.js';

describe('normalizeTransactionOverride', () => {
  it('normalizes blank category and note overrides to null', () => {
    expect(normalizeTransactionOverride({ categoryId: '', note: '   ' })).toEqual({
      categoryId: null,
      note: null,
    });
  });

  it('preserves explicit business and category updates', () => {
    expect(normalizeTransactionOverride({
      businessId: 'business-1',
      categoryId: 'category-1',
      note: '  reviewed  ',
    })).toEqual({
      businessId: 'business-1',
      categoryId: 'category-1',
      note: 'reviewed',
    });
  });
});

describe('manualCategoryFeedbackKey', () => {
  it('groups descriptor variants of one merchant together (normalize, not toLowerCase)', () => {
    const a = manualCategoryFeedbackKey({ businessId: 'b1', merchant: 'SQ *BLUE BOTTLE 402', amountCents: -500 });
    const b = manualCategoryFeedbackKey({ businessId: 'b1', merchant: 'Blue Bottle', amountCents: -700 });
    expect(a).toBe(b);
  });

  it('keeps businesses and directions apart', () => {
    const spend = manualCategoryFeedbackKey({ businessId: 'b1', merchant: 'Stripe', amountCents: -500 });
    expect(manualCategoryFeedbackKey({ businessId: 'b2', merchant: 'Stripe', amountCents: -500 })).not.toBe(spend);
    expect(manualCategoryFeedbackKey({ businessId: 'b1', merchant: 'Stripe', amountCents: 500 })).not.toBe(spend);
  });
});

describe('shouldLearnFromManualCategory', () => {
  it('learns from spend corrections only', () => {
    expect(shouldLearnFromManualCategory(-500, false)).toBe(true);
    expect(shouldLearnFromManualCategory(500, true)).toBe(false);
    expect(shouldLearnFromManualCategory(-500, true)).toBe(false);
  });
});
