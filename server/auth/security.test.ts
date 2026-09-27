import { generateSync } from 'otplib';
import { describe, expect, it } from 'vitest';
import { LoginThrottle, LayeredLoginThrottle } from './loginThrottle.js';
import { OAUTH_STATE_TTL_MS, signOAuthState, verifyOAuthState } from './oauthState.js';
import { createTotpSecret, resetTotpReplayCache, verifyTotpForUser } from './totp.js';

const secret = 'test-session-secret-that-is-long-enough';

describe('Gmail OAuth state', () => {
  it('round-trips the business id for the initiating user', () => {
    const state = signOAuthState(secret, { userId: 'user-1', businessId: 'biz-1' });
    const result = verifyOAuthState(secret, state, 'user-1');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.b).toBe('biz-1');
  });

  it('uses a fresh nonce each time', () => {
    const a = signOAuthState(secret, { userId: 'u', businessId: null });
    const b = signOAuthState(secret, { userId: 'u', businessId: null });
    expect(a).not.toBe(b);
  });

  it('rejects tampering, the wrong secret, another user, expiry and replay', () => {
    const now = 1_800_000_000_000;
    const state = signOAuthState(secret, { userId: 'user-1', businessId: null }, now);
    const [encoded, sig] = state.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(encoded, 'base64url').toString()), b: 'evil' })).toString('base64url');

    expect(verifyOAuthState(secret, `${forged}.${sig}`, 'user-1', now)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyOAuthState('another-secret-that-is-long-enough!!', state, 'user-1', now)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyOAuthState(secret, '{"businessId":null}', 'user-1', now)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyOAuthState(secret, state, 'user-2', now)).toEqual({ ok: false, reason: 'user_mismatch' });
    expect(verifyOAuthState(secret, state, 'user-1', now + OAUTH_STATE_TTL_MS + 1)).toEqual({ ok: false, reason: 'expired' });
    expect(verifyOAuthState(secret, state, 'user-1', now).ok).toBe(true);
    expect(verifyOAuthState(secret, state, 'user-1', now)).toEqual({ ok: false, reason: 'replayed' });
  });
});

describe('LoginThrottle', () => {
  it('locks a username after five failures for fifteen minutes', () => {
    let now = 0;
    const throttle = new LoginThrottle(5, 15 * 60_000, () => now);
    for (let i = 0; i < 4; i += 1) throttle.recordFailure('Admin');
    expect(throttle.isLocked('admin')).toBe(false);
    throttle.recordFailure(' admin ');
    expect(throttle.isLocked('ADMIN')).toBe(true);
    expect(() => throttle.assertNotLocked('admin')).toThrow('Too many sign-in attempts');
    expect(throttle.isLocked('someone-else')).toBe(false);
    now += 15 * 60_000 + 1;
    expect(throttle.isLocked('admin')).toBe(false);
  });

  it('clears failures on success and forgets stale failures', () => {
    let now = 0;
    const throttle = new LoginThrottle(5, 15 * 60_000, () => now);
    for (let i = 0; i < 4; i += 1) throttle.recordFailure('admin');
    throttle.recordSuccess('admin');
    throttle.recordFailure('admin');
    expect(throttle.isLocked('admin')).toBe(false);

    for (let i = 0; i < 3; i += 1) throttle.recordFailure('admin');
    now += 16 * 60_000;
    throttle.recordFailure('admin');
    expect(throttle.isLocked('admin')).toBe(false);
  });

  it('throws a 429 without revealing whether the account exists', () => {
    const throttle = new LoginThrottle(1, 60_000);
    throttle.recordFailure('no-such-user');
    try {
      throttle.assertNotLocked('no-such-user');
      expect.unreachable();
    } catch (error) {
      expect((error as { statusCode: number }).statusCode).toBe(429);
    }
  });
});

describe('verifyTotpForUser', () => {
  it('rejects a replayed code and accepts the next time step', () => {
    resetTotpReplayCache();
    const { secret: totpSecret } = createTotpSecret('admin');
    const epoch = 1_800_000_010;
    const code = generateSync({ secret: totpSecret, epoch });
    expect(verifyTotpForUser('user-1', totpSecret, code, epoch)).toBe(true);
    expect(verifyTotpForUser('user-1', totpSecret, code, epoch)).toBe(false);
    // Replay tracking is per user.
    expect(verifyTotpForUser('user-2', totpSecret, code, epoch)).toBe(true);
    const next = generateSync({ secret: totpSecret, epoch: epoch + 30 });
    expect(verifyTotpForUser('user-1', totpSecret, next, epoch + 30)).toBe(true);
    expect(verifyTotpForUser('user-1', totpSecret, '000000', epoch + 60)).toBe(false);
  });
});

describe('LayeredLoginThrottle', () => {
  it('locks a username only from the IP that failed, until the per-username ceiling', () => {
    const throttle = new LayeredLoginThrottle(new LoginThrottle(5), new LoginThrottle(30));
    for (let i = 0; i < 5; i += 1) throttle.recordFailure('owner', '203.0.113.9');
    expect(() => throttle.assertNotLocked('owner', '203.0.113.9')).toThrow();
    expect(() => throttle.assertNotLocked('owner', '198.51.100.1')).not.toThrow();
    for (let i = 0; i < 25; i += 1) throttle.recordFailure('owner', `10.0.0.${i}`);
    expect(() => throttle.assertNotLocked('owner', '198.51.100.1')).toThrow();
  });
});
