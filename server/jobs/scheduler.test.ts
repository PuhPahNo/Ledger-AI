import { describe, expect, it } from 'vitest';
import { DAILY_PLAID_SYNC_INTERVAL_MS, isPlaidConnectionDueForDailySync } from './scheduler.js';

describe('isPlaidConnectionDueForDailySync', () => {
  const now = new Date('2026-05-24T12:00:00.000Z');

  it('syncs connections that have never synced', () => {
    expect(isPlaidConnectionDueForDailySync(null, now)).toBe(true);
  });

  it('syncs connections once they are at least 24 hours stale', () => {
    expect(isPlaidConnectionDueForDailySync(
      new Date(now.getTime() - DAILY_PLAID_SYNC_INTERVAL_MS),
      now,
    )).toBe(true);
  });

  it('skips connections synced recently', () => {
    expect(isPlaidConnectionDueForDailySync(
      new Date(now.getTime() - DAILY_PLAID_SYNC_INTERVAL_MS + 1),
      now,
    )).toBe(false);
  });
});
