import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { connections } from '../db/schema.js';
import { enqueue } from '../jobs/queue.js';

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
