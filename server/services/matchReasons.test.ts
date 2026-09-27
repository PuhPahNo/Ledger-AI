import { describe, expect, it } from 'vitest';
import { explainMatch, formatUsd, type MatchReasonInput } from './matchReasons.js';
import { explainReceiptMatch, scoreMatch } from './matching.js';
import type { Receipt, Transaction } from '../db/schema.js';

function input(overrides: {
  receipt?: Partial<MatchReasonInput['receipt']>;
  transaction?: Partial<MatchReasonInput['transaction']>;
  accountMask?: string | null;
  components?: Record<string, unknown>;
} = {}): MatchReasonInput {
  return {
    receipt: { merchant: 'Adobe', totalCents: 5499, receiptDate: '2026-09-10', businessId: 'b1', cardLast4: null, ...overrides.receipt },
    transaction: { merchant: 'Adobe Creative Cloud', amountCents: -5499, date: '2026-09-10', authorizedDate: null, businessId: 'b1', ...overrides.transaction },
    accountMask: overrides.accountMask ?? null,
    components: { amountScore: 1, dateScore: 1, merchantScore: 0.9, cardScore: 0.5, businessScore: 1, dateBasis: 'posted', ...overrides.components },
  };
}

const byKind = (reasons: ReturnType<typeof explainMatch>, kind: string) => reasons.find((reason) => reason.kind === kind);

describe('explainMatch', () => {
  it('describes an exact, same-day, same-merchant match', () => {
    const reasons = explainMatch(input());
    expect(reasons.map((reason) => reason.kind)).toEqual(['amount', 'date', 'merchant', 'business']);
    expect(byKind(reasons, 'amount')).toMatchObject({ text: 'Amount exact', strength: 'strong', score: 1 });
    expect(byKind(reasons, 'date')).toMatchObject({ text: 'Same day', strength: 'strong' });
    expect(byKind(reasons, 'merchant')?.text).toBe('"Adobe" ≈ "Adobe Creative Cloud"');
    expect(byKind(reasons, 'business')?.text).toBe('Same business');
  });

  it('reports the amount difference in dollars', () => {
    const reasons = explainMatch(input({ receipt: { totalCents: 5539 }, components: { amountScore: 0.6 } }));
    expect(byKind(reasons, 'amount')).toMatchObject({ text: 'Amount off by $0.40 (receipt higher)', strength: 'good' });
    const far = explainMatch(input({ receipt: { totalCents: 15000 }, components: { amountScore: 0 } }));
    expect(byKind(far, 'amount')?.strength).toBe('conflict');
  });

  it('counts days apart and prefers the authorization date when closer', () => {
    expect(byKind(explainMatch(input({ transaction: { date: '2026-09-13' }, components: { dateScore: 0.4 } })), 'date')?.text).toBe('3 days apart');
    expect(byKind(explainMatch(input({ transaction: { date: '2026-09-11' } })), 'date')?.text).toBe('1 day apart');
    const authorized = explainMatch(input({
      transaction: { date: '2026-09-14', authorizedDate: '2026-09-10' },
      components: { dateBasis: 'authorized' },
    }));
    expect(byKind(authorized, 'date')?.text).toBe('Same day (card authorization date)');
  });

  it('explains card agreement and contradiction', () => {
    const same = explainMatch(input({ receipt: { cardLast4: '4242' }, accountMask: '4242', components: { cardScore: 1 } }));
    expect(byKind(same, 'card')).toMatchObject({ text: 'Card ••4242 matches', strength: 'strong' });
    const different = explainMatch(input({ receipt: { cardLast4: '1111' }, accountMask: '4242', components: { cardScore: 0 } }));
    expect(byKind(different, 'card')).toMatchObject({ text: 'Different card ••1111 (charged to ••4242)', strength: 'conflict' });
    expect(byKind(explainMatch(input({ accountMask: '4242' })), 'card')).toBeUndefined();
  });

  it('treats a merchant mismatch as weak, never a conflict', () => {
    const reasons = explainMatch(input({ receipt: { merchant: 'City of Austin' }, transaction: { merchant: 'PAYMENTUS' }, components: { merchantScore: 0 } }));
    expect(byKind(reasons, 'merchant')).toMatchObject({ strength: 'weak', text: 'Merchant names differ ("City of Austin" vs "PAYMENTUS")' });
  });

  it('omits signals the receipt lacks', () => {
    const reasons = explainMatch(input({ receipt: { merchant: null, businessId: null } }));
    expect(reasons.map((reason) => reason.kind)).toEqual(['amount', 'date']);
  });

  it('formats dollars with separators', () => {
    expect(formatUsd(123456)).toBe('$1,234.56');
    expect(formatUsd(-40)).toBe('$0.40');
  });
});

describe('explainReceiptMatch', () => {
  it('derives reasons from the real scorer, including the receipt card', () => {
    const receipt = {
      id: 'r1', businessId: 'b1', source: 'quickbooks', status: 'pending', merchant: 'Sweetgreen', totalCents: 3821,
      receiptDate: '2026-05-22', ocrJson: { paymentLast4: '4002' }, confidence: '0.9', userEditedFields: [],
    } as unknown as Receipt;
    const transaction = {
      id: 't1', businessId: 'b1', merchant: 'SWEETGREEN', amountCents: -3821, date: '2026-05-23', authorizedDate: null,
      receiptStatus: 'missing', receiptId: null,
    } as unknown as Transaction;
    const reasons = explainReceiptMatch(receipt, transaction, '4002');
    expect(reasons.map((reason) => reason.text)).toEqual([
      'Amount exact',
      '1 day apart',
      'Merchant "Sweetgreen" matches',
      'Card ••4002 matches',
      'Same business',
    ]);
    expect(scoreMatch(receipt, transaction, '4002').score).toBeGreaterThan(0.9);
  });
});
