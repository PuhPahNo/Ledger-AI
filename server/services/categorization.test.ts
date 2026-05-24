import { describe, expect, it } from 'vitest';
import {
  categoryMatchesTransactionDirection,
  preferredIncomeCategory,
  ruleMatches,
} from './categorization.js';

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

describe('categoryMatchesTransactionDirection', () => {
  const revenue = { id: 'revenue', businessId: null, name: 'Revenue', taxCode: 'income' };
  const commissions = { id: 'fees', businessId: null, name: 'Commissions & Fees', taxCode: 'schedule_c_line_10' };

  it('keeps inflows in income categories only', () => {
    expect(categoryMatchesTransactionDirection(revenue, 125000)).toBe(true);
    expect(categoryMatchesTransactionDirection(commissions, 125000)).toBe(false);
  });

  it('keeps outflows out of income categories', () => {
    expect(categoryMatchesTransactionDirection(revenue, -2500)).toBe(false);
    expect(categoryMatchesTransactionDirection(commissions, -2500)).toBe(true);
  });
});

describe('preferredIncomeCategory', () => {
  it('prefers the business-specific income category before the global one', () => {
    const categories = [
      { id: 'global-revenue', businessId: null, name: 'Revenue', taxCode: 'income' },
      { id: 'business-income', businessId: 'business-1', name: 'Income', taxCode: null },
    ];

    expect(preferredIncomeCategory(categories, 'business-1')?.id).toBe('business-income');
  });
});
