import { describe, expect, it } from 'vitest';
import { decideExternalSignal, normalizeSignalSource } from './externalCategorySignals.js';

describe('decideExternalSignal', () => {
  const base = { currentCategoryId: 'misc', currentSource: 'ai_suggested', proposedCategoryId: 'meals', threshold: 0.9 };

  it('applies confident signals to machine-set categories', () => {
    expect(decideExternalSignal({ ...base, confidence: 0.95 })).toBe('apply');
  });

  it('sends low-confidence signals to review', () => {
    expect(decideExternalSignal({ ...base, confidence: 0.7 })).toBe('review');
  });

  it('never overwrites human-set categories', () => {
    expect(decideExternalSignal({ ...base, currentSource: 'manual', confidence: 1 })).toBe('review');
    expect(decideExternalSignal({ ...base, currentSource: 'user_confirmed_rule', confidence: 1 })).toBe('review');
  });

  it('is a no-op when it agrees', () => {
    expect(decideExternalSignal({ ...base, proposedCategoryId: 'misc', confidence: 0.2 })).toBe('unchanged');
  });
});

describe('normalizeSignalSource', () => {
  it('produces a short safe label', () => {
    expect(normalizeSignalSource(' QuickBooks ')).toBe('quickbooks');
    expect(normalizeSignalSource('Xero Online!')).toBe('xero_online_');
    expect(normalizeSignalSource('')).toBe('external');
  });
});
