import { describe, expect, it } from 'vitest';
import { GMAIL_BACKFILL_DAYS, gmailBackfillQuery } from './gmail.js';

describe('gmailBackfillQuery', () => {
  it('defaults to 90 days of receipt-like email search', () => {
    expect(gmailBackfillQuery()).toBe(`newer_than:${GMAIL_BACKFILL_DAYS}d (receipt OR invoice OR order OR confirmation)`);
  });

  it('clamps unsupported day windows', () => {
    expect(gmailBackfillQuery(0)).toContain('newer_than:1d');
    expect(gmailBackfillQuery(999)).toContain('newer_than:365d');
  });
});
