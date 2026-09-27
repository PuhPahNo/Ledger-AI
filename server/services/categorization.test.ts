import { describe, expect, it } from 'vitest';
import {
  AI_AUTO_APPLY_CONFIDENCE,
  PROTECTED_CATEGORY_SOURCES,
  buildCategorizationPrompt,
  compareRulePrecedence,
  containsTerm,
  merchantPatternTokens,
  ruleCategorySource,
  shouldAutoApplyAiSuggestion,
  validateRuleCategory,
  categorizationRetryDelayMs,
  categorizationWebToolOptions,
  categoryNameForKnownSignals,
  categoryMatchesTransactionDirection,
  isAiEligibleCategory,
  isExcludedFromSpendCategory,
  normalize,
  preferredIncomeCategory,
  ruleMatches,
  shouldUseCategorizationWebSearch,
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
  const transfers = { id: 'transfers', businessId: null, name: 'Transfers', taxCode: 'exclude_transfer' };

  it('keeps inflows in income categories only', () => {
    expect(categoryMatchesTransactionDirection(revenue, 125000)).toBe(true);
    expect(categoryMatchesTransactionDirection(commissions, 125000)).toBe(false);
  });

  it('keeps outflows out of income categories', () => {
    expect(categoryMatchesTransactionDirection(revenue, -2500)).toBe(false);
    expect(categoryMatchesTransactionDirection(commissions, -2500)).toBe(true);
  });

  it('allows transfer categories in either direction so they stay out of spend', () => {
    expect(categoryMatchesTransactionDirection(transfers, 125000)).toBe(true);
    expect(categoryMatchesTransactionDirection(transfers, -125000)).toBe(true);
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

describe('categoryNameForKnownSignals', () => {
  it('maps transfer and credit card payment hints to Transfers', () => {
    expect(categoryNameForKnownSignals({
      businessId: 'business-1',
      merchant: 'Online Payment Thank You',
      amountCents: -500000,
      plaidCategory: ['LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'],
    })).toBe('Transfers');

    expect(categoryNameForKnownSignals({
      businessId: 'business-1',
      merchant: 'ACH Credit',
      amountCents: 500000,
      plaidCategory: ['TRANSFER_IN', 'TRANSFER_IN_DEPOSIT'],
    })).toBe('Transfers');
  });

  it('maps common Plaid and merchant hints before AI is needed', () => {
    expect(categoryNameForKnownSignals({
      businessId: 'business-1',
      merchant: 'Google Ads',
      amountCents: -120000,
      plaidCategory: ['GENERAL_SERVICES', 'ADVERTISING_AND_MARKETING'],
    })).toBe('Advertising & Marketing');

    expect(categoryNameForKnownSignals({
      businessId: 'business-1',
      merchant: 'Comcast Business',
      amountCents: -12995,
      plaidCategory: ['RENT_AND_UTILITIES', 'TELECOMMUNICATIONS'],
    })).toBe('Utilities');
  });
});

describe('isExcludedFromSpendCategory', () => {
  it('identifies transfer categories that should not count as spend', () => {
    expect(isExcludedFromSpendCategory({ name: 'Transfers', taxCode: 'exclude_transfer' })).toBe(true);
    expect(isExcludedFromSpendCategory({ name: 'Software', taxCode: 'other_expense_software' })).toBe(false);
  });
});

describe('isAiEligibleCategory', () => {
  it('does not let the model present Uncategorized as an AI recommendation', () => {
    expect(isAiEligibleCategory({
      id: 'uncategorized',
      businessId: null,
      name: 'Uncategorized',
      taxCode: 'review_required',
    }, -2500)).toBe(false);
    expect(isAiEligibleCategory({
      id: 'software',
      businessId: null,
      name: 'Software',
      taxCode: 'other_expense_software',
    }, -2500)).toBe(true);
  });
});

describe('normalize', () => {
  it('lowercases and collapses punctuation', () => {
    expect(normalize('Eleven-Labs, Inc.')).toBe('eleven labs inc');
  });

  it('strips payment-processor prefixes from bank descriptors', () => {
    expect(normalize('SQ *BOBA GUYS SF')).toBe('boba guys sf');
    expect(normalize('TST* MCDONALDS')).toBe('mcdonalds');
    expect(normalize('PAYPAL *SPOTIFY')).toBe('spotify');
  });

  it('drops per-location store numbers but keeps meaningful digits', () => {
    expect(normalize('STARBUCKS 800 4467')).toBe('starbucks');
    expect(normalize('7-Eleven')).toBe('7 eleven');
    expect(normalize('76 Fuel')).toBe('76 fuel');
  });

  it('never normalizes a merchant down to nothing', () => {
    expect(normalize('411')).toBe('411');
  });

  it('matches the same merchant across descriptor styles', () => {
    expect(normalize('SQ *BLUE BOTTLE 402')).toBe(normalize('Blue Bottle'));
  });
});

describe('AI categorization cost controls', () => {
  it('keeps web search off the base request', () => {
    expect(categorizationWebToolOptions(false)).toEqual({});
  });

  it('allows one low-context web lookup only for the explicit fallback request', () => {
    expect(categorizationWebToolOptions(true)).toEqual({
      tools: [{ type: 'web_search_preview', search_context_size: 'low' }],
      tool_choice: { type: 'web_search_preview' },
      max_tool_calls: 1,
    });
  });

  it('escalates only model-flagged ambiguity while the feature remains enabled', () => {
    expect(shouldUseCategorizationWebSearch({ needsWebSearch: true }, true)).toBe(true);
    expect(shouldUseCategorizationWebSearch({ needsWebSearch: false }, true)).toBe(false);
    expect(shouldUseCategorizationWebSearch({ needsWebSearch: true }, false)).toBe(false);
  });

  it('backs repeated failures off for a week, then a month', () => {
    expect(categorizationRetryDelayMs(1)).toBe(7 * 24 * 60 * 60 * 1000);
    expect(categorizationRetryDelayMs(2)).toBe(30 * 24 * 60 * 60 * 1000);
    expect(categorizationRetryDelayMs(8)).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

describe('keyword signals use whole words', () => {
  const signal = (merchant: string, plaidCategory: string[] = []) => categoryNameForKnownSignals({
    businessId: 'business-1',
    merchant,
    amountCents: -5000,
    plaidCategory,
  });

  it('does not match a keyword buried inside another word', () => {
    expect(signal('Policy Surrender Fee')).not.toBe('Cloud');
    expect(signal('Parent Teacher Assoc')).not.toBe('Rent Or Lease');
    expect(signal('Concurrent Systems')).not.toBe('Rent Or Lease');
    expect(containsTerm('first national', 'irs')).toBe(false);
  });

  it('still matches the keyword as its own word, including simple plurals', () => {
    expect(signal('Render.com')).toBe('Cloud');
    expect(signal('Office Rent March')).toBe('Rent Or Lease');
    expect(signal('Delta', ['TRAVEL', 'AIRLINES_AND_AVIATION_SERVICES'])).toBe('Travel');
    expect(signal('PG&E', ['RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_GAS_AND_ELECTRICITY'])).toBe('Utilities');
    expect(signal('Verizon', ['RENT_AND_UTILITIES_TELEPHONE'])).toBe('Utilities');
  });
});

describe('rule precedence', () => {
  const base = { matchKind: 'merchant_contains', userConfirmed: false, updatedAt: new Date('2026-01-01') };

  it('orders by priority first', () => {
    const rules = [
      { ...base, id: 'global-1', priority: 1, businessId: null },
      { ...base, id: 'biz-5', priority: 5, businessId: 'b1' },
    ].sort(compareRulePrecedence);
    expect(rules.map((rule) => rule.id)).toEqual(['global-1', 'biz-5']);
  });

  it('lets a business-specific rule win a priority tie with a global rule', () => {
    const rules = [
      { ...base, id: 'global', priority: 100, businessId: null },
      { ...base, id: 'business', priority: 100, businessId: 'b1' },
    ].sort(compareRulePrecedence);
    expect(rules[0].id).toBe('business');
  });

  it('then prefers user-confirmed and more specific rules', () => {
    const rules = [
      { ...base, id: 'contains', priority: 10, businessId: 'b1', matchKind: 'merchant_contains' },
      { ...base, id: 'exact', priority: 10, businessId: 'b1', matchKind: 'merchant_exact' },
      { ...base, id: 'trusted', priority: 10, businessId: 'b1', userConfirmed: true, matchKind: 'amount_range' },
    ].sort(compareRulePrecedence);
    expect(rules.map((rule) => rule.id)).toEqual(['trusted', 'exact', 'contains']);
  });
});

describe('rule trust', () => {
  it('trusts a user-confirmed rule regardless of priority', () => {
    expect(ruleCategorySource({ userConfirmed: true })).toBe('user_confirmed_rule');
    expect(ruleCategorySource({ userConfirmed: false })).toBe('auto_rule');
  });

  it('treats manual, confirmed-rule and receipt categories as protected', () => {
    expect([...PROTECTED_CATEGORY_SOURCES].sort()).toEqual(['manual', 'receipt_evidence', 'user_confirmed_rule']);
    expect(PROTECTED_CATEGORY_SOURCES.has('ai_suggested')).toBe(false);
  });
});

describe('validateRuleCategory', () => {
  const software = { id: 'software', businessId: null, name: 'Software', taxCode: 'other_expense_software' };
  const revenue = { id: 'revenue', businessId: null, name: 'Revenue', taxCode: 'income' };
  const transfers = { id: 'transfers', businessId: null, name: 'Transfers', taxCode: 'exclude_transfer' };
  const bizOnly = { id: 'biz', businessId: 'b1', name: 'Inventory', taxCode: null };

  it('accepts global categories and categories owned by the rule business', () => {
    expect(validateRuleCategory({ ruleBusinessId: 'b1', category: software })).toBeNull();
    expect(validateRuleCategory({ ruleBusinessId: 'b1', category: bizOnly })).toBeNull();
  });

  it('rejects another business category, or a business category on a global rule', () => {
    expect(validateRuleCategory({ ruleBusinessId: 'b2', category: bizOnly })).toMatch(/different business/);
    expect(validateRuleCategory({ ruleBusinessId: null, category: bizOnly })).toMatch(/global rule/);
  });

  it('rejects archived categories', () => {
    expect(validateRuleCategory({ ruleBusinessId: null, category: { ...software, active: false } })).toMatch(/archived/);
  });

  it('rejects flipping a rule between spend and income, but allows transfers', () => {
    expect(validateRuleCategory({ ruleBusinessId: null, category: revenue, previousCategory: software })).toMatch(/files spend/);
    expect(validateRuleCategory({ ruleBusinessId: null, category: software, previousCategory: revenue })).toMatch(/files income/);
    expect(validateRuleCategory({ ruleBusinessId: null, category: transfers, previousCategory: software })).toBeNull();
  });
});

describe('buildCategorizationPrompt', () => {
  const categories = [{ id: 'software', businessId: null, name: 'Software', taxCode: 'other_expense_software' }];

  it('keeps the category list ahead of all per-transaction data so the prefix caches', () => {
    const prompt = buildCategorizationPrompt(
      { merchant: 'Figma', amountCents: -1500, plaidCategory: [] },
      categories,
      [{ merchant: 'Figma' }],
      false,
    );
    const categoriesAt = prompt.indexOf('Categories:');
    expect(categoriesAt).toBeGreaterThan(-1);
    expect(prompt.indexOf('Transaction:')).toBeGreaterThan(categoriesAt);
    expect(prompt.indexOf('Accepted feedback examples:')).toBeGreaterThan(categoriesAt);
    expect(prompt.trimEnd().split('\n').at(-1)).toMatch(/^Transaction: /);
  });

  it('shares an identical prefix through the category list across transactions', () => {
    const a = buildCategorizationPrompt({ merchant: 'Figma', amountCents: -1500 }, categories, [], false);
    const b = buildCategorizationPrompt({ merchant: 'Refund', amountCents: 2000 }, categories, [{ x: 1 }], true);
    const prefix = a.slice(0, a.indexOf('Categories:') + JSON.stringify(categories).length + 'Categories: '.length);
    expect(b.startsWith(prefix)).toBe(true);
  });
});

describe('merchantPatternTokens (SQL prefilter safety)', () => {
  it('only requires words that appear in the raw lowercased merchant of every true match', () => {
    const merchants = ['SQ *BLUE BOTTLE 402', 'TST* MCDONALDS', 'STARBUCKS 800 4467', 'PAYPAL *SPOTIFY', '7-Eleven #1234'];
    for (const merchant of merchants) {
      const pattern = normalize(merchant);
      for (const token of merchantPatternTokens(pattern)) {
        expect(merchant.toLowerCase()).toContain(token);
      }
    }
  });
});

describe('AI auto-apply threshold', () => {
  it('uses one threshold for sync and the nightly scan', () => {
    expect(AI_AUTO_APPLY_CONFIDENCE).toBe(0.85);
    expect(shouldAutoApplyAiSuggestion({ source: 'ai_suggested', confidence: 0.85 })).toBe(true);
    expect(shouldAutoApplyAiSuggestion({ source: 'ai_suggested', confidence: 0.84 })).toBe(false);
    expect(shouldAutoApplyAiSuggestion({ source: 'ai_suggested', confidence: null })).toBe(false);
    expect(shouldAutoApplyAiSuggestion({ source: 'auto_rule', confidence: 1 })).toBe(false);
  });
});
