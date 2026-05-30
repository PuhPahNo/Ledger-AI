import { describe, expect, it } from 'vitest';
import {
  DAILY_PLAID_SYNC_INTERVAL_MS,
  GMAIL_WATCH_RENEWAL_WINDOW_MS,
  isGmailWatchRenewalDue,
  isPlaidConnectionDueForDailySync,
} from './scheduler.js';

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

describe('isGmailWatchRenewalDue', () => {
  const now = new Date('2026-05-30T12:00:00.000Z');

  it('renews Gmail watches with no expiration', () => {
    expect(isGmailWatchRenewalDue(null, now)).toBe(true);
  });

  it('renews Gmail watches once they are inside the renewal window', () => {
    expect(isGmailWatchRenewalDue(
      new Date(now.getTime() + GMAIL_WATCH_RENEWAL_WINDOW_MS),
      now,
    )).toBe(true);
  });

  it('skips Gmail watches with enough time remaining', () => {
    expect(isGmailWatchRenewalDue(
      new Date(now.getTime() + GMAIL_WATCH_RENEWAL_WINDOW_MS + 1),
      now,
    )).toBe(false);
  });
});
