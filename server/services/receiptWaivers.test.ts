import { describe, expect, it } from 'vitest';
import {
  describeWaiverRule,
  evaluateReceiptWaiver,
  isLodgingSpend,
  merchantRuleMatches,
  normalizeWaiverMerchant,
  type WaiverRuleLike,
  type WaiverSubject,
} from './receiptWaivers.js';

function rule(overrides: Partial<WaiverRuleLike> = {}): WaiverRuleLike {
  return {
    id: 'threshold',
    kind: 'threshold',
    enabled: true,
    businessId: null,
    thresholdCents: 7500,
    excludeLodging: true,
    merchantPattern: null,
    categoryId: null,
    ...overrides,
  };
}

function txn(overrides: Partial<WaiverSubject> = {}): WaiverSubject {
  return {
    amountCents: -4200,
    merchant: 'Blue Bottle Coffee',
    businessId: 'b1',
    categoryId: 'meals',
    categoryName: 'Meals',
    categoryTaxCode: 'schedule_c_line_24b',
    ...overrides,
  };
}

describe('evaluateReceiptWaiver — threshold', () => {
  it('waives outflows strictly under the threshold', () => {
    expect(evaluateReceiptWaiver(txn(), [rule()])).toMatchObject({ ruleId: 'threshold', kind: 'threshold', label: 'Under $75.00 (lodging excluded)' });
    expect(evaluateReceiptWaiver(txn({ amountCents: -7499 }), [rule()])).not.toBeNull();
    expect(evaluateReceiptWaiver(txn({ amountCents: -7500 }), [rule()])).toBeNull();
    expect(evaluateReceiptWaiver(txn({ amountCents: -12000 }), [rule()])).toBeNull();
  });

  it('never waives inflows or refunds', () => {
    expect(evaluateReceiptWaiver(txn({ amountCents: 4200 }), [rule()])).toBeNull();
    expect(evaluateReceiptWaiver(txn({ amountCents: 0 }), [rule()])).toBeNull();
  });

  it('does nothing while disabled (the seeded default)', () => {
    expect(evaluateReceiptWaiver(txn(), [rule({ enabled: false })])).toBeNull();
  });

  it('respects a custom threshold', () => {
    expect(evaluateReceiptWaiver(txn({ amountCents: -2600 }), [rule({ thresholdCents: 2500 })])).toBeNull();
    expect(evaluateReceiptWaiver(txn({ amountCents: -2400 }), [rule({ thresholdCents: 2500 })])?.label).toBe('Under $25.00 (lodging excluded)');
  });
});

describe('evaluateReceiptWaiver — lodging exclusion', () => {
  it('keeps Travel-category and hotel spend requiring a receipt when excluded', () => {
    expect(evaluateReceiptWaiver(txn({ categoryName: 'Travel', merchant: 'Uber' }), [rule()])).toBeNull();
    expect(evaluateReceiptWaiver(txn({ categoryName: 'Uncategorized', merchant: 'MARRIOTT AUSTIN' }), [rule()])).toBeNull();
    expect(evaluateReceiptWaiver(txn({ categoryName: null, categoryTaxCode: null, merchant: 'Hampton Inn #123' }), [rule()])).toBeNull();
  });

  it('waives them when the exclusion is off', () => {
    expect(evaluateReceiptWaiver(txn({ categoryName: 'Travel' }), [rule({ excludeLodging: false })])).not.toBeNull();
  });

  it('detects lodging spend', () => {
    expect(isLodgingSpend({ merchant: 'AIRBNB * HM123', categoryName: 'Other' })).toBe(true);
    expect(isLodgingSpend({ merchant: 'Adobe', categoryName: 'Software' })).toBe(false);
    expect(isLodgingSpend({ merchant: 'Linkedin', categoryName: 'Lodging' })).toBe(true);
  });
});

describe('evaluateReceiptWaiver — merchant and category rules', () => {
  const adobe = rule({ id: 'adobe', kind: 'merchant', merchantPattern: normalizeWaiverMerchant('Adobe'), merchantLabel: 'Adobe', thresholdCents: null });
  const software = rule({ id: 'software', kind: 'category', categoryId: 'software', thresholdCents: null });

  it('matches merchant rules on the condensed descriptor at any amount', () => {
    expect(evaluateReceiptWaiver(txn({ merchant: 'ADOBE *CREATIVE CLD', amountCents: -59999 }), [adobe]))
      .toMatchObject({ ruleId: 'adobe', kind: 'merchant', label: 'Merchant: Adobe' });
    expect(evaluateReceiptWaiver(txn({ merchant: 'Figma' }), [adobe])).toBeNull();
  });

  it('matches category rules by id', () => {
    expect(evaluateReceiptWaiver(txn({ categoryId: 'software', amountCents: -30000 }), [software], new Map([['software', 'Software']])))
      .toMatchObject({ ruleId: 'software', kind: 'category', label: 'Category: Software' });
    expect(evaluateReceiptWaiver(txn({ categoryId: 'meals', amountCents: -30000 }), [software])).toBeNull();
  });

  it('prefers merchant over category over threshold evidence', () => {
    const subject = txn({ merchant: 'Adobe', categoryId: 'software', amountCents: -1000 });
    expect(evaluateReceiptWaiver(subject, [rule(), software, adobe])?.ruleId).toBe('adobe');
    expect(evaluateReceiptWaiver(subject, [rule(), software])?.ruleId).toBe('software');
    expect(evaluateReceiptWaiver(subject, [rule()])?.ruleId).toBe('threshold');
  });

  it('scopes business-specific rules to their business', () => {
    const scoped = { ...adobe, businessId: 'b2' };
    expect(evaluateReceiptWaiver(txn({ merchant: 'Adobe' }), [scoped])).toBeNull();
    expect(evaluateReceiptWaiver(txn({ merchant: 'Adobe', businessId: 'b2' }), [scoped])).not.toBeNull();
  });

  it('merchant rules still win over the lodging exclusion (the user chose them explicitly)', () => {
    const marriott = rule({ id: 'm', kind: 'merchant', merchantPattern: 'marriott' });
    expect(evaluateReceiptWaiver(txn({ merchant: 'MARRIOTT AUSTIN' }), [rule(), marriott])?.ruleId).toBe('m');
  });
});

describe('merchant normalization', () => {
  it('strips processor prefixes, store numbers, suffixes, and TLDs', () => {
    expect(normalizeWaiverMerchant('ADOBE *CREATIVE CLD')).toBe('adobecreativecld');
    expect(normalizeWaiverMerchant('SQ *BLUE BOTTLE #1234')).toBe('bluebottle');
    expect(normalizeWaiverMerchant('Notion Labs, Inc.')).toBe('notionlabs');
    expect(normalizeWaiverMerchant('Elevenlabs.io')).toBe('elevenlabs');
  });

  it('refuses patterns too short to be safe', () => {
    expect(merchantRuleMatches('ab', 'ABBA Records')).toBe(false);
    expect(merchantRuleMatches(null, 'Anything')).toBe(false);
    expect(merchantRuleMatches('notion', 'NOTION LABS INC')).toBe(true);
  });

  it('describes rules', () => {
    expect(describeWaiverRule(rule({ excludeLodging: false }))).toBe('Under $75.00');
    expect(describeWaiverRule(rule({ kind: 'merchant', merchantPattern: 'adobe', merchantLabel: null }))).toBe('Merchant: adobe');
  });
});
