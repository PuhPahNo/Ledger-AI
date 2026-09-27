import { describe, expect, it } from 'vitest';
import {
  amountSearchVariants,
  buildTransactionGmailQuery,
  merchantSearchTerms,
  buildEmailBodyCandidate,
  collectReceiptAttachments,
  gmailReceiptStorageKey,
  looksLikeReceiptOrInvoiceText,
  messageReceiptSignal,
  type GmailMimePart,
} from './gmailReceiptIntake.js';

function encoded(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

const keywordOnlySignal = { isReceiptLike: false, hasReceiptKeyword: true };
const receiptLikeSignal = { isReceiptLike: true, hasReceiptKeyword: true };

describe('gmail receipt intake', () => {
  it('collects image and PDF attachments when the message mentions a receipt', () => {
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

    expect(collectReceiptAttachments(payload, keywordOnlySignal)).toEqual([
      { filename: 'IMG_1234.jpg', mimeType: 'image/jpeg', attachmentId: 'image-1' },
      { filename: 'May-invoice.pdf', mimeType: 'application/pdf', attachmentId: 'pdf-1' },
    ]);
  });

  it('ignores a generic PDF on a message without any receipt signal', () => {
    const payload: GmailMimePart = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          filename: 'Parking-Garage-Map.pdf',
          mimeType: 'application/pdf',
          body: { attachmentId: 'pdf-1', size: 240_000 },
        },
        {
          filename: 'photo.jpg',
          mimeType: 'image/jpeg',
          body: { attachmentId: 'image-1', size: 900_000 },
        },
      ],
    };

    expect(collectReceiptAttachments(payload)).toEqual([]);
  });

  it('keeps a receipt-named PDF even when the message itself has no signal', () => {
    const payload: GmailMimePart = {
      mimeType: 'multipart/mixed',
      parts: [{
        filename: 'invoice-8841.pdf',
        mimeType: 'application/pdf',
        body: { attachmentId: 'pdf-1', size: 42_000 },
      }],
    };

    expect(collectReceiptAttachments(payload)).toEqual([
      { filename: 'invoice-8841.pdf', mimeType: 'application/pdf', attachmentId: 'pdf-1' },
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

    expect(collectReceiptAttachments(payload, receiptLikeSignal)).toEqual([]);
  });

  it('grades message signals as keyword-only versus corroborated', () => {
    expect(messageReceiptSignal('OmegaParking Services\nYour monthly parking update')).toEqual({
      isReceiptLike: false,
      hasReceiptKeyword: false,
    });
    expect(messageReceiptSignal('Your receipt is attached')).toEqual({
      isReceiptLike: false,
      hasReceiptKeyword: true,
    });
    expect(messageReceiptSignal('Receipt from Sweetgreen — Total $38.21')).toEqual({
      isReceiptLike: true,
      hasReceiptKeyword: true,
    });
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

describe('gmailReceiptStorageKey', () => {
  const base = { connectionId: 'conn', messageId: 'msg', fileName: 'invoice.pdf' };

  it('keeps same-named attachments in one message from colliding', () => {
    const a = gmailReceiptStorageKey({ ...base, contentSha256: 'a'.repeat(64) });
    const b = gmailReceiptStorageKey({ ...base, contentSha256: 'b'.repeat(64) });
    expect(a).not.toBe(b);
    expect(a).toBe(`receipts/gmail/conn/msg/${'a'.repeat(16)}-invoice.pdf`);
  });

  it('is stable for identical content and sanitizes the filename', () => {
    const key = gmailReceiptStorageKey({ ...base, fileName: '../May invoice.pdf', contentSha256: 'c'.repeat(64) });
    expect(key).toBe(gmailReceiptStorageKey({ ...base, fileName: '../May invoice.pdf', contentSha256: 'c'.repeat(64) }));
    expect(key).not.toContain('..');
    expect(key.startsWith('receipts/gmail/conn/msg/')).toBe(true);
  });
});

describe('buildTransactionGmailQuery', () => {
  it('searches the amount or the merchant with receipt wording within ±7 days', () => {
    const result = buildTransactionGmailQuery({ merchant: 'ADOBE *CREATIVE CLD', amountCents: -5499, date: '2026-09-10' });
    expect(result.from).toBe('2026-09-03');
    expect(result.to).toBe('2026-09-17');
    expect(result.amountVariants).toEqual(['54.99']);
    expect(result.merchantTerms).toEqual(['adobe', 'creative', 'cld']);
    expect(result.query).toBe(
      'after:2026/09/03 before:2026/09/18 ("54.99" OR (adobe (receipt OR invoice OR order OR payment OR billing OR subscription)))',
    );
  });

  it('spans both the authorized and posted dates', () => {
    const result = buildTransactionGmailQuery({ merchant: 'Figma', amountCents: -1500, date: '2026-09-12', authorizedDate: '2026-09-09' });
    expect(result.from).toBe('2026-09-02');
    expect(result.to).toBe('2026-09-19');
  });

  it('adds a thousands-separated amount spelling', () => {
    expect(amountSearchVariants(-123450)).toEqual(['1234.50', '1,234.50']);
    expect(amountSearchVariants(7500)).toEqual(['75.00']);
    expect(amountSearchVariants(0)).toEqual([]);
  });

  it('extracts distinctive merchant words from bank descriptors', () => {
    expect(merchantSearchTerms('SQ *BLUE BOTTLE #1234')).toEqual(['blue', 'bottle']);
    expect(merchantSearchTerms('AMZN Mktp US*2K4')).toEqual(['amazon']);
    expect(merchantSearchTerms('PAYPAL *NOTION LABS')).toEqual(['notion', 'labs']);
    expect(merchantSearchTerms('POS DEBIT 12345')).toEqual([]);
  });

  it('falls back to the amount alone for an unsearchable merchant', () => {
    const result = buildTransactionGmailQuery({ merchant: 'POS 4411', amountCents: -2000, date: '2026-01-02' });
    expect(result.query).toBe('after:2025/12/26 before:2026/01/10 ("20.00")');
  });
});
