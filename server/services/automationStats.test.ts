import { describe, expect, it } from 'vitest';
import { tallyAutomatedTransactions } from './automationStats.js';

describe('tallyAutomatedTransactions', () => {
  it('counts each transaction once, latest automated source wins', () => {
    const result = tallyAutomatedTransactions(
      [
        { id: 't1', source: 'auto_rule' },
        { id: 't2', source: 'ai_suggested' },
        { id: 't3', source: 'plaid_signal' },
        { id: 't4', source: 'manual' },
      ],
      [
        { transactionId: 't2', source: 'user_confirmed_rule' },
        { transactionId: 't5', source: 'receipt_evidence' },
        { transactionId: 't6', source: 'external_signal' },
      ],
    );
    expect(result).toEqual({
      total: 5,
      bySource: { rule: 2, ai: 0, plaidSignal: 1, receiptEvidence: 1, external: 1 },
    });
  });
});
