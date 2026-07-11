import { describe, expect, it } from 'vitest';
import { tagRuleMatches } from './tagging.js';

describe('tagRuleMatches', () => {
  it('matches merchant contains rules case-insensitively', () => {
    expect(tagRuleMatches(
      { matchKind: 'merchant_contains', pattern: 'openai' },
      'OpenAI *ChatGPT Subscr',
    )).toBe(true);
  });

  it('matches merchant exact rules after processor-prefix normalization', () => {
    expect(tagRuleMatches(
      { matchKind: 'merchant_exact', pattern: 'anthropic' },
      'PAYPAL *ANTHROPIC',
    )).toBe(true);
  });

  it('does not match unrelated merchants', () => {
    expect(tagRuleMatches(
      { matchKind: 'merchant_contains', pattern: 'openai' },
      'Starbucks 800 4467',
    )).toBe(false);
  });

  it('never matches an empty pattern', () => {
    expect(tagRuleMatches(
      { matchKind: 'merchant_contains', pattern: '   ' },
      'OpenAI',
    )).toBe(false);
  });

  it('matches an exact category after normalization', () => {
    expect(tagRuleMatches(
      { matchKind: 'category_exact', pattern: 'Software' },
      { merchant: 'ElevenLabs', categoryName: 'software' },
    )).toBe(true);
  });

  it('matches text extracted from a paired receipt', () => {
    expect(tagRuleMatches(
      { matchKind: 'receipt_contains', pattern: 'client dinner' },
      { merchant: 'Bistro 27', receiptText: 'Business purpose: Client dinner with ACME' },
    )).toBe(true);
  });

  it('does not let a receipt rule fall back to merchant text', () => {
    expect(tagRuleMatches(
      { matchKind: 'receipt_contains', pattern: 'openai' },
      { merchant: 'OpenAI', receiptText: null },
    )).toBe(false);
  });
});
