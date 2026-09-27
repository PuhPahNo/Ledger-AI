import { describe, expect, it } from 'vitest';
import { categorySourceLabel, categorySourceTag } from './categorySource';

describe('categorySource', () => {
  it('labels QuickBooks signals and learned rules', () => {
    expect(categorySourceLabel('external_signal', { signalSource: 'quickbooks' })).toBe('From QuickBooks');
    expect(categorySourceLabel('user_confirmed_rule', { learningEventId: 'x' })).toBe('Learned rule');
    expect(categorySourceLabel('user_confirmed_rule')).toBe('Your rule');
  });
  it('tags QuickBooks-applied categories', () => {
    expect(categorySourceTag('external_signal', undefined, { signalSource: 'quickbooks' })).toBe('QBO');
    expect(categorySourceTag('external_signal')).toBe('ext');
    expect(categorySourceTag('manual')).toBeNull();
  });
});
