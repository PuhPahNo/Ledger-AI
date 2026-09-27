import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { createPlaidWebhookVerifier, type PlaidWebhookVerifier } from '../auth/plaidWebhookVerification.js';
import { getEnv } from '../config/env.js';
import { db } from '../db/client.js';
import { connections, jobs } from '../db/schema.js';
import { enqueue } from '../jobs/queue.js';
import { HttpError, unauthorized } from '../lib/errors.js';
import { plaidClient } from '../services/plaid.js';

export function isValidWebhookSecret(expected: string, provided: string | undefined): boolean {
  if (!expected) return true;
  if (!provided) return false;

  const expectedBuffer = Buffer.from(expected);
  const candidates = new Set([provided]);
  if (provided.includes(' ')) candidates.add(provided.replaceAll(' ', '+'));

  for (const candidate of candidates) {
    const providedBuffer = Buffer.from(candidate);
    if (expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer)) {
      return true;
    }
  }
  return false;
}

/**
 * Plaid webhook authorization policy. A request is accepted when the optional
 * ?secret= query parameter matches PLAID_WEBHOOK_SECRET, or when Plaid's signed
 * Plaid-Verification JWT verifies. In production with Plaid configured, anything else
 * is rejected; elsewhere the previous behaviour (open unless a secret is set) is kept.
 */
export function isPlaidWebhookAuthorized(input: {
  production: boolean;
  plaidConfigured: boolean;
  expectedSecret: string;
  providedSecret: string | undefined;
  jwtVerified: boolean;
}): boolean {
  if (input.expectedSecret && isValidWebhookSecret(input.expectedSecret, input.providedSecret)) return true;
  if (input.jwtVerified) return true;
  if (input.production && input.plaidConfigured) return false;
  return isValidWebhookSecret(input.expectedSecret, input.providedSecret);
}

let defaultVerifier: PlaidWebhookVerifier | null = null;
function plaidVerifier(): PlaidWebhookVerifier {
  defaultVerifier ??= createPlaidWebhookVerifier(async (kid) => {
    const client = plaidClient();
    if (!client) return null;
    const response = await client.webhookVerificationKeyGet({ key_id: kid });
    return response.data.key;
  });
  return defaultVerifier;
}

/** Raw request bodies for the Plaid route, captured by its scoped JSON parser. */
const rawBodies = new WeakMap<FastifyRequest, string>();

/** ITEM webhook codes that mean the bank login must be redone before syncs can succeed. */
const PLAID_REAUTH_CODES = new Set([
  'ITEM_LOGIN_REQUIRED',
  'PENDING_EXPIRATION',
  'PENDING_DISCONNECT',
  'USER_PERMISSION_REVOKED',
]);

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  // Encapsulated so the raw-body JSON parser only applies to the Plaid webhook route.
  await app.register(async (plaidScope) => {
    plaidScope.removeContentTypeParser('application/json');
    plaidScope.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
      const raw = typeof body === 'string' ? body : body.toString('utf8');
      rawBodies.set(request, raw);
      try {
        done(null, raw.length ? JSON.parse(raw) : {});
      } catch {
        done(new HttpError(400, 'Invalid JSON body'), undefined);
      }
    });
    plaidScope.post('/webhooks/plaid', async (request) => handlePlaidWebhook(request));
  });

  app.post('/webhooks/google/pubsub', async (request) => {
    const env = getEnv();
    const query = z.object({ secret: z.string().optional() }).parse(request.query ?? {});
    if (!isValidWebhookSecret(env.GOOGLE_PUBSUB_WEBHOOK_SECRET, query.secret)) {
      unauthorized('Invalid Google Pub/Sub webhook secret');
    }

    const body = z.object({
      message: z.object({ data: z.string(), messageId: z.string().optional() }),
    }).parse(request.body);
    const decoded = JSON.parse(Buffer.from(body.message.data, 'base64url').toString('utf8')) as {
      emailAddress?: string;
      historyId?: string;
    };
    if (decoded.emailAddress) {
      const connection = await db.query.connections.findFirst({ where: eq(connections.gmailEmail, decoded.emailAddress) });
      if (connection) {
        await db.update(connections).set({
          metadata: {
            ...connection.metadata,
            lastWebhookAt: new Date().toISOString(),
            lastPubSubAt: new Date().toISOString(),
            lastPubSubHistoryId: decoded.historyId ?? null,
            lastPubSubMessageId: body.message.messageId ?? null,
          },
          updatedAt: new Date(),
        }).where(eq(connections.id, connection.id));
        // Gmail pushes one notification per mailbox change; coalesce them so a burst of
        // mail doesn't pile up duplicate syncs. A sync that is already running may have
        // read history before this change, so only a queued (not yet started, or
        // waiting to retry) job absorbs the notification.
        if (!(await hasPendingGmailSync(connection.id))) {
          await enqueue('gmail.sync', { connectionId: connection.id, historyId: decoded.historyId });
        }
      }
    }
    return { ok: true };
  });
}

async function hasPendingGmailSync(connectionId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(
      eq(jobs.type, 'gmail.sync'),
      inArray(jobs.status, ['queued', 'failed']),
      sql`${jobs.attempts} < ${jobs.maxAttempts}`,
      sql`${jobs.payload}->>'connectionId' = ${connectionId}`,
    ))
    .limit(1);
  return Boolean(row);
}

async function handlePlaidWebhook(request: FastifyRequest) {
  const env = getEnv();
  const query = z.object({ secret: z.string().optional() }).parse(request.query ?? {});
  const production = env.NODE_ENV === 'production';
  const plaidConfigured = Boolean(env.PLAID_CLIENT_ID && env.PLAID_SECRET);
  const secretMatches = Boolean(env.PLAID_WEBHOOK_SECRET) && isValidWebhookSecret(env.PLAID_WEBHOOK_SECRET, query.secret);

  let jwtVerified = false;
  const verificationHeader = request.headers['plaid-verification'];
  if (!secretMatches && plaidConfigured && typeof verificationHeader === 'string') {
    const result = await plaidVerifier().verify(verificationHeader, rawBodies.get(request));
    jwtVerified = result.ok;
    if (!result.ok) request.log.warn({ reason: result.reason }, 'Plaid webhook verification failed');
  }

  if (!isPlaidWebhookAuthorized({
    production,
    plaidConfigured,
    expectedSecret: env.PLAID_WEBHOOK_SECRET,
    providedSecret: query.secret,
    jwtVerified: secretMatches || jwtVerified,
  })) {
    unauthorized('Invalid Plaid webhook signature');
  }

  const body = z.object({
    webhook_type: z.string(),
    webhook_code: z.string(),
    item_id: z.string().optional(),
    error: z.object({ error_code: z.string().optional() }).nullable().optional(),
  }).passthrough().parse(request.body);

  if (!body.item_id) return { ok: true };
  const connection = await db.query.connections.findFirst({ where: eq(connections.providerItemId, body.item_id) });
  if (!connection) return { ok: true };

  await db.update(connections).set({
    metadata: {
      ...connection.metadata,
      lastWebhookAt: new Date().toISOString(),
      lastWebhookType: body.webhook_type,
      lastWebhookCode: body.webhook_code,
    },
    updatedAt: new Date(),
  }).where(eq(connections.id, connection.id));

  // LOGIN_REPAIRED: the bank login works again, so sync now — a successful sync flips the
  // connection from 'reauth' back to 'live'.
  const loginRepaired = body.webhook_type === 'ITEM' && body.webhook_code === 'LOGIN_REPAIRED';
  if (body.webhook_type === 'TRANSACTIONS' || (loginRepaired && connection.status !== 'disconnected')) {
    await enqueue('plaid.sync', { connectionId: connection.id });
  }

  // Previously parsed and dropped: expired bank logins kept the connection 'live' while
  // every sync failed. Flag reauth so the scheduler stops retrying and the UI can say why.
  const needsReauth = body.webhook_type === 'ITEM'
    && (PLAID_REAUTH_CODES.has(body.webhook_code)
      || (body.webhook_code === 'ERROR' && body.error?.error_code === 'ITEM_LOGIN_REQUIRED'));
  if (needsReauth && connection.status === 'live') {
    await db.update(connections).set({ status: 'reauth', updatedAt: new Date() }).where(eq(connections.id, connection.id));
  }
  return { ok: true };
}
