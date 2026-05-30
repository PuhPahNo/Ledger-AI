import { describe, expect, it } from 'vitest';
import { receiptPreviewKind } from './receiptPreview';

describe('receiptPreviewKind', () => {
  it('recognizes browser-previewable receipt formats', () => {
    expect(receiptPreviewKind('application/pdf', 'invoice.pdf')).toBe('pdf');
    expect(receiptPreviewKind('image/jpeg', 'receipt.jpg')).toBe('image');
    expect(receiptPreviewKind('text/plain', 'receipt.txt')).toBe('text');
    expect(receiptPreviewKind('text/markdown', 'receipt.md')).toBe('text');
    expect(receiptPreviewKind('text/html', 'receipt.html')).toBe('html');
  });

  it('does not pretend HEIC files are browser-renderable', () => {
    expect(receiptPreviewKind('image/heic', 'receipt.heic')).toBe('unsupported');
  });
});
