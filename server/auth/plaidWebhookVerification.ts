import { createHash, createPublicKey, timingSafeEqual, verify as cryptoVerify, type KeyObject } from 'node:crypto';

/**
 * Plaid webhook verification (https://plaid.com/docs/api/webhooks/webhook-verification/).
 *
 * Plaid signs every webhook with an ES256 JWT in the `Plaid-Verification` header. The JWT
 * payload carries `iat` and `request_body_sha256`; the signing key is fetched by `kid`
 * from /webhook_verification_key/get and may be cached.
 */
export const PLAID_WEBHOOK_MAX_AGE_SECONDS = 5 * 60;
const KEY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface PlaidJwk {
  alg?: string;
  crv: string;
  kid?: string;
  kty: string;
  x: string;
  y: string;
  created_at?: number;
  expired_at?: number | null;
}

export type PlaidKeyFetcher = (kid: string) => Promise<PlaidJwk | null>;

export type PlaidVerificationResult =
  | { ok: true }
  | { ok: false; reason: string };

export interface PlaidWebhookVerifier {
  verify(jwt: string | undefined, rawBody: string | undefined): Promise<PlaidVerificationResult>;
}

export function createPlaidWebhookVerifier(
  fetchKey: PlaidKeyFetcher,
  now: () => number = Date.now,
): PlaidWebhookVerifier {
  const cache = new Map<string, { key: KeyObject; expiredAt: number | null; cachedAt: number }>();

  async function keyFor(kid: string): Promise<KeyObject | null> {
    const cached = cache.get(kid);
    if (cached && now() - cached.cachedAt < KEY_CACHE_TTL_MS && cached.expiredAt === null) {
      return cached.key;
    }
    const jwk = await fetchKey(kid);
    if (!jwk) return null;
    // Plaid marks rotated keys with expired_at; signatures from them are no longer valid.
    const expiredAt = jwk.expired_at ?? null;
    if (expiredAt !== null) {
      cache.delete(kid);
      return null;
    }
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') return null;
    const key = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: 'jwk' });
    cache.set(kid, { key, expiredAt, cachedAt: now() });
    return key;
  }

  return {
    async verify(jwt, rawBody) {
      if (!jwt) return { ok: false, reason: 'missing Plaid-Verification header' };
      if (rawBody === undefined) return { ok: false, reason: 'missing raw body' };
      const parts = jwt.split('.');
      if (parts.length !== 3) return { ok: false, reason: 'malformed JWT' };
      const [encodedHeader, encodedPayload, encodedSignature] = parts;

      let header: { alg?: string; kid?: string; typ?: string };
      let payload: { iat?: number; request_body_sha256?: string };
      try {
        header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
        payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
      } catch {
        return { ok: false, reason: 'malformed JWT' };
      }
      if (header.alg !== 'ES256') return { ok: false, reason: 'unexpected JWT alg' };
      if (!header.kid) return { ok: false, reason: 'missing kid' };

      let key: KeyObject | null;
      try {
        key = await keyFor(header.kid);
      } catch (error) {
        return { ok: false, reason: `key fetch failed: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (!key) return { ok: false, reason: 'unknown or expired key' };

      const signature = Buffer.from(encodedSignature, 'base64url');
      if (signature.length !== 64) return { ok: false, reason: 'bad signature length' };
      const signatureValid = cryptoVerify(
        'sha256',
        Buffer.from(`${encodedHeader}.${encodedPayload}`),
        { key, dsaEncoding: 'ieee-p1363' },
        signature,
      );
      if (!signatureValid) return { ok: false, reason: 'bad signature' };

      if (typeof payload.iat !== 'number') return { ok: false, reason: 'missing iat' };
      const ageSeconds = now() / 1000 - payload.iat;
      // Small allowance for clock skew in the other direction.
      if (ageSeconds > PLAID_WEBHOOK_MAX_AGE_SECONDS || ageSeconds < -60) {
        return { ok: false, reason: 'stale webhook' };
      }

      if (typeof payload.request_body_sha256 !== 'string') return { ok: false, reason: 'missing body hash' };
      const actual = Buffer.from(createHash('sha256').update(rawBody, 'utf8').digest('hex'));
      const claimed = Buffer.from(payload.request_body_sha256.toLowerCase());
      if (actual.length !== claimed.length || !timingSafeEqual(actual, claimed)) {
        return { ok: false, reason: 'body hash mismatch' };
      }
      return { ok: true };
    },
  };
}
