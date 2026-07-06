import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getEnv } from '../config/env.js';
import { db } from '../db/client.js';
import { connections } from '../db/schema.js';
import { enqueue } from '../jobs/queue.js';
import { unauthorized } from '../lib/errors.js';

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

/** ITEM webhook codes that mean the bank login must be redone before syncs can succeed. */
const PLAID_REAUTH_CODES = new Set([
  'ITEM_LOGIN_REQUIRED',
  'PENDING_EXPIRATION',
  'PENDING_DISCONNECT',
  'USER_PERMISSION_REVOKED',
]);

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.post('/webhooks/plaid', async (request) => {
    const env = getEnv();
    const query = z.object({ secret: z.string().optional() }).parse(request.query ?? {});
    if (!isValidWebhookSecret(env.PLAID_WEBHOOK_SECRET, query.secret)) {
      unauthorized('Invalid Plaid webhook secret');
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

    if (body.webhook_type === 'TRANSACTIONS') {
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
        await enqueue('gmail.sync', { connectionId: connection.id, historyId: decoded.historyId });
      }
    }
    return { ok: true };
  });
}
