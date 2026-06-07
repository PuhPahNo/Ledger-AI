import { describe, expect, it } from 'vitest';
import {
  AUTO_ATTACH_THRESHOLD,
  annotateCandidates,
  decideMatch,
  scoreMatch,
  type ScoredCandidate,
} from './matching.js';
import type { Receipt, Transaction } from '../db/schema.js';

function makeReceipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    id: 'r1',
    businessId: 'b1',
    source: 'gmail',
    status: 'pending',
    merchant: 'Sweetgreen',
    totalCents: 3821,
    receiptDate: '2026-05-22',
    fileKey: null,
    fileName: null,
    mimeType: null,
    fileSha256: null,
    gmailMessageId: null,
    gmailAttachmentId: null,
    uploadedByUserId: null,
    uploadedByUploaderId: null,
    transactionId: null,
    confidence: null,
    ocrJson: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Receipt;
}

function makeTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 't1',
    businessId: 'b1',
    accountId: null,
    plaidTransactionId: null,
    date: '2026-05-22',
    authorizedDate: null,
    merchant: 'Sweetgreen',
    amountCents: -3821,
    categoryId: null,
    categorySource: 'uncategorized',
    categoryConfidence: null,
    categoryEvidence: {},
    receiptId: null,
    receiptStatus: 'missing',
    sourceLabel: 'Amex 4002',
    note: null,
    flag: null,
    pending: false,
    raw: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Transaction;
}

describe('scoreMatch', () => {
  it('strongly scores same merchant, amount, date, and business', () => {
    const result = scoreMatch(makeReceipt(), makeTransaction());
    expect(result.score).toBeGreaterThanOrEqual(0.95);
  });

  it('penalizes wrong amount and merchant', () => {
    const result = scoreMatch(
      makeReceipt({ merchant: 'Apple Store', totalCents: 99900 }),
      makeTransaction(),
    );
    expect(result.score).toBeLessThan(0.5);
  });

  it('rewards a matching card last-4 and penalizes a contradicting one', () => {
    // Tax-style receipt: exact amount + date, but payee name never resembles the bank descriptor.
    const receipt = makeReceipt({
      merchant: 'Federal and Georgia tax authorities',
      ocrJson: { paymentLast4: '4002' },
    });
    const transaction = makeTransaction({ merchant: 'IRS USATAXPYMT' });

    const matched = scoreMatch(receipt, transaction, '4002');
    const unknown = scoreMatch(receipt, transaction, null);
    const contradicted = scoreMatch(receipt, transaction, '9999');

    expect(matched.score).toBeGreaterThan(unknown.score);
    expect(unknown.score).toBeGreaterThan(contradicted.score);
    // A confirmed card match should clear the auto-attach bar even with zero merchant overlap.
    expect(matched.score).toBeGreaterThanOrEqual(AUTO_ATTACH_THRESHOLD);
  });

  it('matches "Eleven Labs Inc." to bank descriptor "Elevenlabs.io" via condensed name', () => {
    const result = scoreMatch(
      makeReceipt({ merchant: 'Eleven Labs Inc.', totalCents: 2376, receiptDate: '2026-03-25' }),
      makeTransaction({ merchant: 'Elevenlabs.io', amountCents: -2376, date: '2026-03-26' }),
    );
    // Strong amount + date + condensed-merchant match should auto-attach even without card info.
    expect(Number(result.reasons.merchantScore)).toBeGreaterThanOrEqual(0.9);
    expect(result.score).toBeGreaterThanOrEqual(AUTO_ATTACH_THRESHOLD);
  });
});

describe('decideMatch', () => {
  const scored = (over: Partial<ScoredCandidate> & { score: number }): ScoredCandidate => ({
    transaction: makeTransaction(),
    reasons: { dateScore: 1, cardScore: 0.5 },
    exactAmount: true,
    ...over,
  });

  it('attaches a unique exact-amount, in-window match even below the auto bar', () => {
    const decision = decideMatch([scored({ score: 0.8 })]);
    expect(decision?.attach).toBe(true);
  });

  it('does not attach when two candidates are essentially tied', () => {
    const decision = decideMatch([
      scored({ score: 0.86 }),
      scored({ score: 0.855 }),
    ]);
    expect(decision?.attach).toBe(false);
  });

  it('does not attach a unique match when the card contradicts', () => {
    const decision = decideMatch([
      scored({ score: 0.8, reasons: { dateScore: 1, cardScore: 0 } }),
    ]);
    expect(decision?.attach).toBe(false);
  });

  it('still attaches a high-confidence match above the auto bar', () => {
    const decision = decideMatch([scored({ score: 0.95, exactAmount: false })]);
    expect(decision?.attach).toBe(true);
  });

  it('returns null when nothing clears the suggested floor', () => {
    expect(decideMatch([scored({ score: 0.3 })])).toBeNull();
    expect(decideMatch([])).toBeNull();
  });

  it('annotates the best tied candidate as ambiguous instead of auto-safe', () => {
    const [best, second] = annotateCandidates([
      scored({ score: 0.86 }),
      scored({ score: 0.855, transaction: makeTransaction({ id: 't2' }) }),
    ]);
    expect(best.suggested).toBe(true);
    expect(best.ambiguous).toBe(true);
    expect(best.wouldAutoAttach).toBe(false);
    expect(second.suggested).toBe(false);
  });
});
