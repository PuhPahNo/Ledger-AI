import { describe, expect, it } from 'vitest';
import {
  buildEmailBodyCandidate,
  collectReceiptAttachments,
  looksLikeReceiptOrInvoiceText,
  type GmailMimePart,
} from './gmailReceiptIntake.js';

function encoded(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

describe('gmail receipt intake', () => {
  it('collects receipt image and invoice PDF attachments', () => {
    const payload: GmailMimePart = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          filename: 'IMG_1234.jpg',
          mimeType: 'image/jpeg',
          body: { attachmentId: 'image-1', size: 1_200_000 },
        },
        {
          filename: 'May invoice.pdf',
          mimeType: 'application/pdf',
          body: { attachmentId: 'pdf-1', size: 42_000 },
        },
      ],
    };

    expect(collectReceiptAttachments(payload)).toEqual([
      { filename: 'IMG_1234.jpg', mimeType: 'image/jpeg', attachmentId: 'image-1' },
      { filename: 'May-invoice.pdf', mimeType: 'application/pdf', attachmentId: 'pdf-1' },
    ]);
  });

  it('skips small inline logo images so text receipts can be captured', () => {
    const payload: GmailMimePart = {
      mimeType: 'multipart/related',
      parts: [{
        filename: 'logo.png',
        mimeType: 'image/png',
        body: { attachmentId: 'logo-1', size: 6_000 },
        headers: [{ name: 'Content-Disposition', value: 'inline' }],
      }],
    };

    expect(collectReceiptAttachments(payload, true)).toEqual([]);
  });

  it('builds a text receipt candidate from a receipt-like email body', () => {
    const payload: GmailMimePart = {
      mimeType: 'multipart/alternative',
      parts: [{
        mimeType: 'text/plain',
        body: {
          data: encoded('Thanks for your purchase.\nTotal: $38.21\nDate: 2026-05-22'),
        },
      }],
    };

    const candidate = buildEmailBodyCandidate({
      payload,
      subject: 'Receipt from Sweetgreen',
      from: 'Sweetgreen <receipts@example.com>',
      date: 'Fri, 22 May 2026 13:00:00 -0400',
    });

    expect(candidate?.mimeType).toBe('text/plain');
    expect(candidate?.filename).toBe('receipt-from-sweetgreen-receipt.txt');
    expect(candidate?.text).toContain('Total: $38.21');
  });

  it('rejects ordinary email text without receipt evidence', () => {
    expect(looksLikeReceiptOrInvoiceText('Can we move the team meeting to 3pm?')).toBe(false);
  });
});
