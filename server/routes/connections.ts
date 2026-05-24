import type { FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireUser } from '../auth/session.js';
import { db } from '../db/client.js';
import { accounts, businesses, connections } from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';
import { enqueue } from '../jobs/queue.js';
import { audit } from '../services/audit.js';
import { PLAID_TRANSACTION_HISTORY_DAYS, createPlaidLinkToken, exchangePlaidPublicToken } from '../services/plaid.js';
import { connectGmail, gmailOAuthUrl } from '../services/gmail.js';
import { toApiConnection } from './mappers.js';

export async function connectionRoutes(app: FastifyInstance): Promise<void> {
  app.post('/connections/plaid/link-token', async (request) => {
    const user = await requireUser(request);
    return createPlaidLinkToken(user.id);
  });

  app.post('/connections/plaid/exchange', async (request) => {
    const user = await requireUser(request);
    const body = z.object({ public_token: z.string(), businessId: z.string().uuid().optional() }).parse(request.body);
    const [activePlaid] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(connections)
      .where(and(sql`${connections.kind} <> 'gmail'`, sql`${connections.status} <> 'disconnected'`));
    if ((activePlaid?.count ?? 0) >= 10) {
      badRequest('Ledger AI supports up to 10 active Plaid connections');
    }
    const connectionId = await exchangePlaidPublicToken({ publicToken: body.public_token, businessId: body.businessId });
    await audit(request, user, 'connect_plaid', 'connection', connectionId);
    await enqueue('plaid.sync', { connectionId });
    const row = await db.query.connections.findFirst({ where: eq(connections.id, connectionId) });
    if (!row) notFound();
    return toApiConnection(row);
  });

  app.post('/connections/:id/sync', async (request) => {
    const user = await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const row = await db.query.connections.findFirst({ where: eq(connections.id, params.id) });
    if (!row) notFound('Connection not found');
    await enqueue(row.kind === 'gmail' ? 'gmail.sync' : 'plaid.sync', { connectionId: params.id });
    await audit(request, user, 'sync_connection', 'connection', params.id);
    return { queued: true };
  });

  app.post('/connections/:id/backfill', async (request) => {
    const user = await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ months: z.coerce.number().int().min(1).max(24).default(12) }).parse(request.body ?? {});
    const row = await db.query.connections.findFirst({ where: eq(connections.id, params.id) });
    if (!row) notFound('Connection not found');
    if (row.kind === 'gmail') badRequest('Backfill is only available for Plaid connections');

    const daysRequested = Math.min(body.months * 31, 730);
    await enqueue('plaid.sync', {
      connectionId: params.id,
      resetCursor: true,
      daysRequested,
    });
    await audit(request, user, 'backfill_plaid', 'connection', params.id, { daysRequested });
    return {
      queued: true,
      daysRequested,
      newLinkDaysRequested: PLAID_TRANSACTION_HISTORY_DAYS,
    };
  });

  app.get('/connections/gmail/oauth-url', async (request) => {
    await requireUser(request);
    const query = z.object({ businessId: z.string().uuid().optional() }).parse(request.query);
    return { url: gmailOAuthUrl(JSON.stringify({ businessId: query.businessId ?? null })) };
  });

  app.get('/connections/gmail/callback', async (request, reply) => {
    const query = z.object({ code: z.string(), state: z.string().optional() }).parse(request.query);
    let businessId: string | undefined;
    if (query.state) {
      try {
        const parsed = JSON.parse(query.state) as { businessId?: string | null };
        businessId = parsed.businessId ?? undefined;
      } catch {
        badRequest('Invalid OAuth state');
      }
    }
    const connectionId = await connectGmail(query.code, businessId);
    await enqueue('gmail.sync', { connectionId });
    return reply.redirect('/?connected=gmail');
  });

  app.patch('/connections/:id/business', async (request) => {
    const user = await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ businessId: z.string().uuid().nullable() }).parse(request.body);
    if (body.businessId) {
      const business = await db.query.businesses.findFirst({ where: eq(businesses.id, body.businessId) });
      if (!business) notFound('Business not found');
    }
    const [row] = await db.update(connections).set({ businessId: body.businessId, updatedAt: new Date() }).where(eq(connections.id, params.id)).returning();
    if (!row) notFound('Connection not found');
    await audit(request, user, 'update_connection_business', 'connection', params.id, { businessId: body.businessId });
    return toApiConnection(row);
  });

  app.delete('/connections/:id', async (request, reply) => {
    const user = await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const [row] = await db
      .update(connections)
      .set({ status: 'disconnected', updatedAt: new Date() })
      .where(eq(connections.id, params.id))
      .returning();
    if (!row) notFound('Connection not found');
    await db.update(accounts).set({ enabled: false, updatedAt: new Date() }).where(eq(accounts.connectionId, params.id));
    await audit(request, user, 'disconnect_connection', 'connection', params.id);
    return reply.status(204).send();
  });
}
