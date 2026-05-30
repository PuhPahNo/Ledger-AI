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
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer);
}

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.post('/webhooks/plaid', async (request) => {
    const body = z.object({
      webhook_type: z.string(),
      webhook_code: z.string(),
      item_id: z.string().optional(),
    }).passthrough().parse(request.body);

    if (body.webhook_type === 'TRANSACTIONS' && body.item_id) {
      const connection = await db.query.connections.findFirst({ where: eq(connections.providerItemId, body.item_id) });
      if (connection) await enqueue('plaid.sync', { connectionId: connection.id });
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
      if (connection) await enqueue('gmail.sync', { connectionId: connection.id, historyId: decoded.historyId });
    }
    return { ok: true };
  });
}
