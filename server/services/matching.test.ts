import { describe, expect, it } from 'vitest';
import { scoreMatch } from './matching.js';

describe('scoreMatch', () => {
  it('strongly scores same merchant, amount, date, and business', () => {
    const result = scoreMatch({
      id: 'r1',
      businessId: 'b1',
      source: 'upload',
      status: 'pending',
      merchant: 'Sweetgreen',
      totalCents: 3821,
      receiptDate: '2026-05-22',
      fileKey: null,
      fileName: null,
      mimeType: null,
      gmailMessageId: null,
      gmailAttachmentId: null,
      transactionId: null,
      confidence: null,
      ocrJson: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    }, {
      id: 't1',
      businessId: 'b1',
      accountId: null,
      plaidTransactionId: null,
      date: '2026-05-22',
      authorizedDate: null,
      merchant: 'Sweetgreen',
      amountCents: -3821,
      categoryId: null,
      receiptId: null,
      receiptStatus: 'missing',
      sourceLabel: 'Amex 4002',
      note: null,
      flag: null,
      pending: false,
      raw: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(result.score).toBeGreaterThanOrEqual(0.95);
  });

  it('penalizes wrong amount and merchant', () => {
    const result = scoreMatch({
      id: 'r1',
      businessId: 'b1',
      source: 'upload',
      status: 'pending',
      merchant: 'Apple Store',
      totalCents: 99900,
      receiptDate: '2026-05-22',
      fileKey: null,
      fileName: null,
      mimeType: null,
      gmailMessageId: null,
      gmailAttachmentId: null,
      transactionId: null,
      confidence: null,
      ocrJson: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    }, {
      id: 't1',
      businessId: 'b1',
      accountId: null,
      plaidTransactionId: null,
      date: '2026-05-22',
      authorizedDate: null,
      merchant: 'Sweetgreen',
      amountCents: -3821,
      categoryId: null,
      receiptId: null,
      receiptStatus: 'missing',
      sourceLabel: 'Amex 4002',
      note: null,
      flag: null,
      pending: false,
      raw: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(result.score).toBeLessThan(0.5);
  });
});
