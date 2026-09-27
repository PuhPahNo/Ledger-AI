import { describe, expect, it } from 'vitest';
import {
  PermanentExtractionError,
  extractReceipt,
  isPermanentExtractionFailure,
  receiptExtractionUpdate,
  unsupportedReceiptFileReason,
  type ReceiptExtraction,
} from './receiptExtraction.js';

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

describe('permanent extraction failures', () => {
  it('rejects HEIC/HEIF up front instead of sending them to OpenAI', async () => {
    expect(unsupportedReceiptFileReason({ mimeType: 'image/heic', fileName: 'IMG_1.HEIC' })).toMatch(/HEIC/);
    expect(unsupportedReceiptFileReason({ mimeType: 'application/octet-stream', fileName: 'IMG_1.heif' })).toMatch(/HEIC/);
    expect(unsupportedReceiptFileReason({ mimeType: 'image/tiff', fileName: 'scan.tiff' })).toMatch(/isn't supported/);
    expect(unsupportedReceiptFileReason({ mimeType: 'image/jpeg', fileName: 'IMG_1.jpg' })).toBeNull();
    expect(unsupportedReceiptFileReason({ mimeType: 'application/pdf', fileName: 'invoice.pdf' })).toBeNull();

    const attempt = extractReceipt({ buffer: Buffer.from('heic'), mimeType: 'image/heic', fileName: 'IMG_1.HEIC' });
    await expect(attempt).rejects.toBeInstanceOf(PermanentExtractionError);
  });

  it('classifies which failures should not be retried', () => {
    expect(isPermanentExtractionFailure(new PermanentExtractionError('nope'))).toBe(true);
    expect(isPermanentExtractionFailure(Object.assign(new Error('bad image'), { status: 400 }))).toBe(true);
    expect(isPermanentExtractionFailure(Object.assign(new Error('slow down'), { status: 429 }))).toBe(false);
    expect(isPermanentExtractionFailure(Object.assign(new Error('upstream'), { status: 503 }))).toBe(false);
    expect(isPermanentExtractionFailure(new Error('socket hang up'))).toBe(false);
  });
});

describe('receiptExtractionUpdate', () => {
  const extraction: ReceiptExtraction = {
    isReceipt: true,
    merchant: 'OCR Merchant',
    totalCents: 1000,
    receiptDate: '2026-05-01',
    taxCents: null,
    paymentLast4: null,
    categoryHint: null,
    categoryEvidence: null,
    categoryConfidence: null,
    lineItems: [],
    confidence: 0.9,
    notes: null,
  };
  const current = {
    source: 'gmail' as const,
    status: 'pending' as const,
    transactionId: null,
    merchant: 'User Merchant',
    totalCents: 4200,
    receiptDate: null,
    ocrJson: { subject: 'Your receipt' },
    userEditedFields: ['merchant', 'totalCents'],
  };

  it('never overwrites fields the user edited', () => {
    const update = receiptExtractionUpdate(current, extraction);
    expect(update).not.toHaveProperty('merchant');
    expect(update).not.toHaveProperty('totalCents');
    expect(update.receiptDate).toBe('2026-05-01');
    expect(update.extractionError).toBeNull();
    expect(update.ocrJson).toMatchObject({ subject: 'Your receipt', merchant: 'OCR Merchant' });
  });

  it('reports missing fields against the values that will actually be stored', () => {
    const update = receiptExtractionUpdate(current, { ...extraction, receiptDate: null, totalCents: null });
    expect(update.extractionError).toMatch(/receipt date/);
  });

  it('only auto-dismisses untouched Gmail non-receipts', () => {
    const notReceipt = { ...extraction, isReceipt: false };
    expect(receiptExtractionUpdate({ ...current, userEditedFields: [] }, notReceipt).status).toBe('n/a');
    expect(receiptExtractionUpdate(current, notReceipt).status).toBeUndefined();
    expect(receiptExtractionUpdate({ ...current, userEditedFields: [], transactionId: 't1' }, notReceipt).status).toBeUndefined();
  });
});
