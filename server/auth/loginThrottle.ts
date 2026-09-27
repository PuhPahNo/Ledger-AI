import { HttpError } from '../lib/errors.js';

/**
 * In-memory per-username login lockout shared by the admin login and the receipt upload
 * portal login. Production runs a single web instance, so process memory is sufficient;
 * a restart simply clears the counters.
 *
 * Failures are tracked for unknown usernames too, so the lockout response never reveals
 * whether an account exists.
 */
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_LOCK_MS = 15 * 60 * 1000;
const MAX_TRACKED_USERNAMES = 10_000;

interface FailureState {
  failures: number;
  firstFailureAt: number;
  lockedUntil: number;
}

export const LOGIN_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;
export const LOCKED_MESSAGE = 'Too many sign-in attempts. Try again later.';

export class LoginThrottle {
  private state = new Map<string, FailureState>();

  constructor(
    private readonly maxFailures = LOGIN_MAX_FAILURES,
    private readonly lockMs = LOGIN_LOCK_MS,
    private readonly now: () => number = Date.now,
  ) {}

  isLocked(username: string): boolean {
    const entry = this.state.get(normalize(username));
    return Boolean(entry && entry.lockedUntil > this.now());
  }

  /** Throws a generic 429 when the username is currently locked. */
  assertNotLocked(username: string): void {
    if (this.isLocked(username)) throw new HttpError(429, LOCKED_MESSAGE);
  }

  recordFailure(username: string): void {
    const key = normalize(username);
    const now = this.now();
    let entry = this.state.get(key);
    // Failures older than the lock window no longer count toward a new lock.
    if (!entry || (entry.lockedUntil <= now && now - entry.firstFailureAt > this.lockMs)) {
      entry = { failures: 0, firstFailureAt: now, lockedUntil: 0 };
    }
    entry.failures += 1;
    if (entry.failures >= this.maxFailures) {
      entry.lockedUntil = now + this.lockMs;
      entry.failures = 0;
      entry.firstFailureAt = now;
    }
    this.state.delete(key);
    this.state.set(key, entry);
    this.prune(now);
  }

  recordSuccess(username: string): void {
    this.state.delete(normalize(username));
  }

  reset(): void {
    this.state.clear();
  }

  private prune(now: number): void {
    if (this.state.size <= MAX_TRACKED_USERNAMES) return;
    for (const [key, entry] of this.state) {
      if (entry.lockedUntil <= now && now - entry.firstFailureAt > this.lockMs) this.state.delete(key);
      if (this.state.size <= MAX_TRACKED_USERNAMES) return;
    }
    // Still over the cap: drop the oldest insertion-ordered entries.
    for (const key of this.state.keys()) {
      this.state.delete(key);
      if (this.state.size <= MAX_TRACKED_USERNAMES) return;
    }
  }
}

function normalize(username: string): string {
  return username.trim().toLowerCase();
}

export const loginThrottle = new LoginThrottle();
