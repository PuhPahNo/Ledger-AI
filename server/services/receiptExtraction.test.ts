import { describe, expect, it } from 'vitest';
import { extractReceipt } from './receiptExtraction.js';

describe('receipt extraction fallback', () => {
  it('extracts basic fields from text receipt artifacts without OpenAI', async () => {
    const extraction = await extractReceipt({
      fileName: 'sweetgreen-receipt.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from([
        'Subject: Receipt from Sweetgreen',
        'From: Sweetgreen <receipts@example.com>',
        '',
        'Date: 05/22/2026',
        'Total: $38.21',
      ].join('\n'), 'utf8'),
    });

    expect(extraction.isReceipt).toBe(true);
    expect(extraction.merchant).toBe('Sweetgreen');
    expect(extraction.totalCents).toBe(3821);
    expect(extraction.receiptDate).toBe('2026-05-22');
    expect(extraction.confidence).toBeGreaterThan(0.2);
  });
});
