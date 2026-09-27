import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveLocalStoragePath, storedFileSecurityHeaders } from './storage.js';

describe('resolveLocalStoragePath', () => {
  const root = path.resolve('/srv/ledger-storage');

  it('resolves normal keys inside the root', () => {
    expect(resolveLocalStoragePath(root, 'receipts/2026/a..b-receipt.pdf')).toBe(path.join(root, 'receipts/2026/a..b-receipt.pdf'));
  });

  it('rejects traversal, absolute, empty, root and NUL keys', () => {
    for (const key of ['../etc/passwd', 'receipts/../../etc/passwd', '/etc/passwd', '', '.', 'receipts/..', 'a\0b', '..']) {
      expect(() => resolveLocalStoragePath(root, key), key).toThrow('Invalid storage key');
    }
  });

  it('rejects sibling directories that share the root prefix', () => {
    expect(() => resolveLocalStoragePath(root, '../ledger-storage-evil/x')).toThrow('Invalid storage key');
  });
});

describe('storedFileSecurityHeaders', () => {
  it('sandboxes active content', () => {
    for (const type of ['text/html', 'text/html; charset=utf-8', 'image/svg+xml', 'application/xml', 'application/xhtml+xml', null]) {
      expect(storedFileSecurityHeaders(type)).toEqual({ 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox' });
    }
  });

  it('does not sandbox PDFs or raster images but always sets nosniff', () => {
    for (const type of ['application/pdf', 'image/png', 'image/jpeg', 'text/plain; charset=utf-8']) {
      expect(storedFileSecurityHeaders(type)).toEqual({ 'X-Content-Type-Options': 'nosniff' });
    }
  });
});
