import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { createPlaidWebhookVerifier } from '../auth/plaidWebhookVerification.js';
import { isPlaidWebhookAuthorized, isValidWebhookSecret, webhookRoutes } from './webhooks.js';

describe('webhook secret validation', () => {
  it('allows requests when no secret is configured', () => {
    expect(isValidWebhookSecret('', undefined)).toBe(true);
  });

  it('requires an exact configured secret match', () => {
    expect(isValidWebhookSecret('secret-token', 'secret-token')).toBe(true);
    expect(isValidWebhookSecret('secret-token', undefined)).toBe(false);
    expect(isValidWebhookSecret('secret-token', 'wrong-token')).toBe(false);
    expect(isValidWebhookSecret('secret-token', 'secret-token-extra')).toBe(false);
  });

  it('accepts query-string plus signs decoded as spaces', () => {
    expect(isValidWebhookSecret('abc+123', 'abc 123')).toBe(true);
  });
});

describe('Plaid webhook authorization policy', () => {
  const base = { production: true, plaidConfigured: true, expectedSecret: '', providedSecret: undefined, jwtVerified: false };

  it('rejects unsigned webhooks in production when Plaid is configured', () => {
    expect(isPlaidWebhookAuthorized(base)).toBe(false);
    expect(isPlaidWebhookAuthorized({ ...base, expectedSecret: 's3cret', providedSecret: 'nope' })).toBe(false);
  });

  it('accepts a verified JWT or a matching secret in production', () => {
    expect(isPlaidWebhookAuthorized({ ...base, jwtVerified: true })).toBe(true);
    expect(isPlaidWebhookAuthorized({ ...base, expectedSecret: 's3cret', providedSecret: 's3cret' })).toBe(true);
  });

  it('keeps the previous behaviour outside production or without Plaid configured', () => {
    expect(isPlaidWebhookAuthorized({ ...base, production: false })).toBe(true);
    expect(isPlaidWebhookAuthorized({ ...base, plaidConfigured: false })).toBe(true);
    expect(isPlaidWebhookAuthorized({ ...base, production: false, expectedSecret: 's3cret', providedSecret: 'nope' })).toBe(false);
  });
});

describe('Plaid webhook JWT verification', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string; y: string }), kid: 'kid-1', alg: 'ES256', expired_at: null };
  const body = JSON.stringify({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'item-1' }, null, 2);
  const nowMs = 1_800_000_000_000;

  function sign(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: 'ES256', kid: 'kid-1', typ: 'JWT' }, key = privateKey) {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode(header)}.${encode(payload)}`;
    const signature = cryptoSign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
    return `${input}.${signature.toString('base64url')}`;
  }
  const validPayload = () => ({ iat: Math.floor(nowMs / 1000) - 10, request_body_sha256: createHash('sha256').update(body).digest('hex') });

  it('accepts a correctly signed, fresh webhook and caches the key by kid', async () => {
    const fetchKey = vi.fn().mockResolvedValue(jwk);
    const verifier = createPlaidWebhookVerifier(fetchKey, () => nowMs);
    await expect(verifier.verify(sign(validPayload()), body)).resolves.toEqual({ ok: true });
    await expect(verifier.verify(sign(validPayload()), body)).resolves.toEqual({ ok: true });
    expect(fetchKey).toHaveBeenCalledTimes(1);
    expect(fetchKey).toHaveBeenCalledWith('kid-1');
  });

  it('rejects a tampered body', async () => {
    const verifier = createPlaidWebhookVerifier(async () => jwk, () => nowMs);
    const result = await verifier.verify(sign(validPayload()), body.replace('item-1', 'item-2'));
    expect(result).toEqual({ ok: false, reason: 'body hash mismatch' });
  });

  it('rejects a signature from a different key', async () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    const verifier = createPlaidWebhookVerifier(async () => jwk, () => nowMs);
    const result = await verifier.verify(sign(validPayload(), undefined, other), body);
    expect(result).toEqual({ ok: false, reason: 'bad signature' });
  });

  it('rejects webhooks older than five minutes', async () => {
    const verifier = createPlaidWebhookVerifier(async () => jwk, () => nowMs);
    const result = await verifier.verify(sign({ ...validPayload(), iat: Math.floor(nowMs / 1000) - 301 }), body);
    expect(result).toEqual({ ok: false, reason: 'stale webhook' });
  });

  it('rejects non-ES256 algorithms, expired keys, missing headers and fetch failures', async () => {
    const verifier = createPlaidWebhookVerifier(async () => jwk, () => nowMs);
    expect((await verifier.verify(sign(validPayload(), { alg: 'none', kid: 'kid-1' }), body)).ok).toBe(false);
    expect((await verifier.verify(undefined, body)).ok).toBe(false);
    expect((await verifier.verify('a.b', body)).ok).toBe(false);

    const expired = createPlaidWebhookVerifier(async () => ({ ...jwk, expired_at: 1 }), () => nowMs);
    expect(await expired.verify(sign(validPayload()), body)).toEqual({ ok: false, reason: 'unknown or expired key' });

    const failing = createPlaidWebhookVerifier(async () => { throw new Error('network'); }, () => nowMs);
    expect((await failing.verify(sign(validPayload()), body)).ok).toBe(false);
  });
});

describe('webhook routes body parsing', () => {
  it('parses Plaid JSON through the raw-body parser and leaves other routes on the default parser', async () => {
    const app = Fastify();
    await app.register(async (api) => { await webhookRoutes(api); }, { prefix: '/api' });

    const plaid = await app.inject({
      method: 'POST',
      url: '/api/webhooks/plaid',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ webhook_type: 'ITEM', webhook_code: 'WEBHOOK_UPDATE_ACKNOWLEDGED' }),
    });
    expect(plaid.statusCode).toBe(200);
    expect(plaid.json()).toEqual({ ok: true });

    const badJson = await app.inject({
      method: 'POST',
      url: '/api/webhooks/plaid',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(badJson.statusCode).toBe(400);

    const pubsub = await app.inject({
      method: 'POST',
      url: '/api/webhooks/google/pubsub',
      payload: { message: { data: Buffer.from(JSON.stringify({})).toString('base64url') } },
    });
    expect(pubsub.statusCode).toBe(200);
    await app.close();
  });
});
