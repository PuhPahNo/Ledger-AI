import { describe, expect, it } from 'vitest';
import { canAutoOverwriteCategorySource, receiptEvidenceCanAutoApply } from './categorizationFeedback.js';

describe('receiptEvidenceCanAutoApply', () => {
  it('allows strong receipt evidence to overwrite auto-applied categories', () => {
    expect(receiptEvidenceCanAutoApply({
      matchScore: 0.94,
      receiptConfidence: 0.91,
      categoryConfidence: 0.86,
      categorySource: 'plaid_signal',
    })).toBe(true);
  });

  it('does not silently overwrite manual or user-confirmed categories', () => {
    expect(canAutoOverwriteCategorySource('manual')).toBe(false);
    expect(canAutoOverwriteCategorySource('user_confirmed_rule')).toBe(false);
    expect(receiptEvidenceCanAutoApply({
      matchScore: 0.99,
      receiptConfidence: 0.99,
      categoryConfidence: 0.99,
      categorySource: 'manual',
    })).toBe(false);
  });

  it('requires receipt, match, and category confidence thresholds', () => {
    expect(receiptEvidenceCanAutoApply({
      matchScore: 0.81,
      receiptConfidence: 0.91,
      categoryConfidence: 0.86,
      categorySource: 'auto_rule',
    })).toBe(false);
    expect(receiptEvidenceCanAutoApply({
      matchScore: 0.94,
      receiptConfidence: 0.84,
      categoryConfidence: 0.86,
      categorySource: 'auto_rule',
    })).toBe(false);
    expect(receiptEvidenceCanAutoApply({
      matchScore: 0.94,
      receiptConfidence: 0.91,
      categoryConfidence: 0.79,
      categorySource: 'auto_rule',
    })).toBe(false);
  });
});
