import { describe, expect, it } from 'vitest';
import { PLAID_TRANSACTION_HISTORY_DAYS, plaidAmountCents, plaidBalanceCents } from './plaid.js';

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

describe('plaidAmountCents', () => {
  it('keeps normal Plaid charges as app outflows', () => {
    expect(plaidAmountCents({ amount: 123.45 })).toBe(-12345);
  });

  it('uses Plaid income hints to force app inflows', () => {
    expect(plaidAmountCents({
      amount: 123.45,
      personal_finance_category: { primary: 'INCOME', detailed: 'INCOME_OTHER_INCOME' },
    })).toBe(12345);
  });

  it('uses Plaid transfer-in hints to keep incoming transfers out of spend', () => {
    expect(plaidAmountCents({
      amount: 2000,
      personal_finance_category: { primary: 'TRANSFER_IN', detailed: 'TRANSFER_IN_DEPOSIT' },
    })).toBe(200000);
  });
});
