import { describe, expect, it } from 'vitest';
import type { Receipt, Transaction } from '../db/schema.js';
import { inferReceiptCategory } from './receiptCategoryEvidence.js';

describe('inferReceiptCategory', () => {
  it('suggests nothing for an unreadable (fallback) receipt', async () => {
    const receipt = {
      confidence: '0.2000',
      merchant: 'smith cpa invoice 4471',
      ocrJson: { notes: 'Fallback extraction used because OpenAI is not configured or the file type is not supported by the AI extractor.' },
    } as unknown as Receipt;
    const transaction = { businessId: 'b', amountCents: -250000, merchant: 'SMITH CO CPA', raw: {} } as unknown as Transaction;
    await expect(inferReceiptCategory(receipt, transaction)).resolves.toEqual({
      categoryId: null,
      confidence: 0,
      evidence: { reason: 'receipt_unreadable' },
    });
  });
});
