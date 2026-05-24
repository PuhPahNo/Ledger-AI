import { describe, expect, it } from 'vitest';
import { ruleMatches } from './categorization.js';

describe('ruleMatches', () => {
  it('matches merchant contains rules case-insensitively', () => {
    expect(ruleMatches({
      matchKind: 'merchant_contains',
      pattern: 'notion',
      merchant: 'Notion Annual',
      amountCents: -19200,
    })).toBe(true);
  });

  it('matches merchant exact rules after punctuation normalization', () => {
    expect(ruleMatches({
      matchKind: 'merchant_exact',
      pattern: 'junction',
      merchant: 'Junction',
      amountCents: -621,
    })).toBe(true);
  });

  it('matches Plaid food category hints after underscore normalization', () => {
    expect(ruleMatches({
      matchKind: 'plaid_category',
      pattern: 'food and drink',
      merchant: 'Junction',
      plaidCategory: 'FOOD_AND_DRINK RESTAURANT',
      amountCents: -621,
    })).toBe(true);
  });

  it('matches open-ended amount ranges', () => {
    expect(ruleMatches({
      matchKind: 'amount_range',
      pattern: '10000..',
      merchant: 'United',
      amountCents: -61240,
    })).toBe(true);
  });
});
