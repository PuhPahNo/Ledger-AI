import { describe, expect, it, vi } from 'vitest';
import {
  GMAIL_BACKFILL_DAYS,
  gmailBackfillQuery,
  ingestAvailableGmailMessages,
  isGmailNotFoundError,
} from './gmail.js';

describe('gmailBackfillQuery', () => {
  it('defaults to 90 days of receipt-like email search', () => {
    expect(gmailBackfillQuery()).toBe(`newer_than:${GMAIL_BACKFILL_DAYS}d (receipt OR invoice OR order OR confirmation)`);
  });

  it('clamps unsupported day windows', () => {
    expect(gmailBackfillQuery(0)).toContain('newer_than:1d');
    expect(gmailBackfillQuery(999)).toContain('newer_than:365d');
  });
});

describe('ingestAvailableGmailMessages', () => {
  it('skips Gmail messages that disappeared before fetch', async () => {
    const missing = Object.assign(new Error('Requested entity was not found.'), {
      response: { status: 404, data: { error: { status: 'NOT_FOUND' } } },
    });
    const ingest = vi.fn()
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce(2);

    await expect(ingestAvailableGmailMessages(['ok-1', 'missing', 'ok-2'], ingest))
      .resolves.toEqual({ count: 3, skippedMissing: 1 });
    expect(ingest).toHaveBeenCalledTimes(3);
  });

  it('does not hide non-404 Gmail failures', async () => {
    const outage = Object.assign(new Error('Gmail unavailable'), { response: { status: 503 } });
    const ingest = vi.fn().mockRejectedValueOnce(outage);

    await expect(ingestAvailableGmailMessages(['retry-later'], ingest)).rejects.toThrow('Gmail unavailable');
  });
});

describe('isGmailNotFoundError', () => {
  it('recognizes Gaxios 404 variants from Gmail', () => {
    expect(isGmailNotFoundError({ response: { status: 404 } })).toBe(true);
    expect(isGmailNotFoundError({ response: { data: { error: { code: 404 } } } })).toBe(true);
    expect(isGmailNotFoundError({ response: { data: { error: { status: 'NOT_FOUND' } } } })).toBe(true);
  });
});
