import { describe, expect, it } from 'vitest';
import { PLAID_TRANSACTION_HISTORY_DAYS, plaidBalanceCents } from './plaid.js';

describe('PLAID_TRANSACTION_HISTORY_DAYS', () => {
  it('requests one year of transaction history for new links and explicit backfills', () => {
    expect(PLAID_TRANSACTION_HISTORY_DAYS).toBe(365);
  });
});

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
