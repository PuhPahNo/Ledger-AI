import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Signed, single-use OAuth `state` for the Gmail connect flow. The state binds the
 * callback to the admin who started it (CSRF / login-CSRF protection) and carries the
 * non-secret context (businessId) the callback needs.
 *
 * Format: base64url(JSON payload) + "." + base64url(HMAC-SHA256(secret, context + payload)).
 */
export const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;
const CONTEXT = 'ledger-ai:gmail-oauth-state:v1:';

export interface OAuthStatePayload {
  v: 1;
  /** Random nonce; also used for single-use tracking. */
  n: string;
  /** Initiating admin user id. */
  u: string;
  /** Business the new connection should be assigned to. */
  b: string | null;
  /** Expiry, epoch ms. */
  exp: number;
}

export function signOAuthState(
  secret: string,
  input: { userId: string; businessId: string | null },
  now = Date.now(),
): string {
  const payload: OAuthStatePayload = {
    v: 1,
    n: randomBytes(16).toString('base64url'),
    u: input.userId,
    b: input.businessId,
    exp: now + OAUTH_STATE_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${mac(secret, encoded)}`;
}

export type OAuthStateResult =
  | { ok: true; payload: OAuthStatePayload }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'user_mismatch' | 'replayed' };

const usedNonces = new Map<string, number>();

/**
 * Verifies signature, expiry and that the callback's session user started the flow.
 * A verified state is consumed: presenting it again fails with `replayed`.
 */
export function verifyOAuthState(
  secret: string,
  state: string,
  expectedUserId: string,
  now = Date.now(),
): OAuthStateResult {
  const parts = state.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
  const [encoded, signature] = parts;

  const expected = Buffer.from(mac(secret, encoded));
  const provided = Buffer.from(signature);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as OAuthStatePayload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (payload?.v !== 1 || typeof payload.n !== 'string' || typeof payload.u !== 'string' || typeof payload.exp !== 'number') {
    return { ok: false, reason: 'malformed' };
  }
  if (payload.exp <= now) return { ok: false, reason: 'expired' };
  if (payload.u !== expectedUserId) return { ok: false, reason: 'user_mismatch' };

  pruneNonces(now);
  if (usedNonces.has(payload.n)) return { ok: false, reason: 'replayed' };
  usedNonces.set(payload.n, payload.exp);

  return { ok: true, payload: { ...payload, b: typeof payload.b === 'string' ? payload.b : null } };
}

function mac(secret: string, encodedPayload: string): string {
  return createHmac('sha256', secret).update(CONTEXT).update(encodedPayload).digest('base64url');
}

function pruneNonces(now: number): void {
  for (const [nonce, exp] of usedNonces) {
    if (exp <= now) usedNonces.delete(nonce);
  }
}
