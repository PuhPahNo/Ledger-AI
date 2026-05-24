import { describe, expect, it } from 'vitest';
import { plaidBalanceCents } from './plaid.js';

describe('plaidBalanceCents', () => {
  it('converts Plaid dollar balances to cents', () => {
    expect(plaidBalanceCents(1234.56)).toBe(123456);
    expect(plaidBalanceCents('12.34')).toBe(1234);
  });

  it('returns null for missing or invalid balances', () => {
    expect(plaidBalanceCents(null)).toBeNull();
    expect(plaidBalanceCents(undefined)).toBeNull();
    expect(plaidBalanceCents('not-a-number')).toBeNull();
  });
});
