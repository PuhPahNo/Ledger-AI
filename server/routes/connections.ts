import type { FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { signOAuthState, verifyOAuthState } from '../auth/oauthState.js';
import { requireUser } from '../auth/session.js';
import { getEnv } from '../config/env.js';
import { db } from '../db/client.js';
import { accounts, businesses, connections } from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';
import { enqueue } from '../jobs/queue.js';
import { audit } from '../services/audit.js';
import {
  PLAID_TRANSACTION_HISTORY_DAYS,
  createPlaidLinkToken,
  createPlaidUpdateLinkToken,
  exchangePlaidPublicToken,
  removePlaidItem,
  resumeBlockedPlaidSync,
} from '../services/plaid.js';
import { GMAIL_BACKFILL_DAYS, connectGmail, gmailOAuthUrl } from '../services/gmail.js';
import { toApiConnection } from './mappers.js';

export async function connectionRoutes(app: FastifyInstance): Promise<void> {
  app.post('/connections/plaid/link-token', async (request) => {
    const user = await requireUser(request);
    // With a connectionId this is update-mode Link (re-login for a 'reauth' Item). It reuses
    // the existing Item, so it never counts against the new-connection cap.
    const body = z.object({ connectionId: z.string().uuid().optional() }).parse(request.body ?? {});
    if (body.connectionId) return createPlaidUpdateLinkToken(user.id, body.connectionId);
    return createPlaidLinkToken(user.id);
  });

  app.post('/connections/:id/plaid/reauth-complete', async (request) => {
    const user = await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const row = await db.query.connections.findFirst({ where: eq(connections.id, params.id) });
    if (!row || row.kind === 'gmail') notFound('Plaid connection not found');
    if (row.status === 'disconnected') badRequest('This connection was disconnected. Add it again as a new Plaid connection.');
    // Status flips back to 'live' when this sync succeeds, which proves the new login works.
    const jobId = await enqueue('plaid.sync', { connectionId: params.id });
    await audit(request, user, 'reauth_plaid', 'connection', params.id);
    return { queued: true, jobId };
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
    const jobId = await enqueue(row.kind === 'gmail' ? 'gmail.sync' : 'plaid.sync', { connectionId: params.id });
    await audit(request, user, 'sync_connection', 'connection', params.id);
    return { queued: true, jobId };
  });

  app.post('/connections/:id/backfill', async (request) => {
    const user = await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({
      months: z.coerce.number().int().min(1).max(24).default(12),
      days: z.coerce.number().int().min(1).max(365).optional(),
    }).parse(request.body ?? {});
    const row = await db.query.connections.findFirst({ where: eq(connections.id, params.id) });
    if (!row) notFound('Connection not found');

    if (row.kind === 'gmail') {
      const daysRequested = body.days ?? GMAIL_BACKFILL_DAYS;
      const jobId = await enqueue('gmail.backfill', { connectionId: params.id, daysRequested });
      await audit(request, user, 'backfill_gmail', 'connection', params.id, { daysRequested });
      return {
        queued: true,
        jobId,
        daysRequested,
      };
    }

    const daysRequested = Math.min(body.months * 31, 730);
    const jobId = await enqueue('plaid.sync', {
      connectionId: params.id,
      resetCursor: true,
      daysRequested,
    });
    await audit(request, user, 'backfill_plaid', 'connection', params.id, { daysRequested });
    return {
      queued: true,
      jobId,
      daysRequested,
      newLinkDaysRequested: PLAID_TRANSACTION_HISTORY_DAYS,
    };
  });

  app.get('/connections/gmail/oauth-url', async (request) => {
    const user = await requireUser(request);
    const query = z.object({ businessId: z.string().uuid().optional() }).parse(request.query);
    const state = signOAuthState(getEnv().SESSION_SECRET, { userId: user.id, businessId: query.businessId ?? null });
    return { url: gmailOAuthUrl(state) };
  });

  // Google redirects the browser here (top-level GET, so the sameSite=lax session cookie is
  // sent). The signed state must have been issued to this same admin within 15 minutes.
  app.get('/connections/gmail/callback', async (request, reply) => {
    const user = await requireUser(request);
    const query = z.object({ code: z.string(), state: z.string() }).parse(request.query);
    const verified = verifyOAuthState(getEnv().SESSION_SECRET, query.state, user.id);
    if (!verified.ok) {
      request.log.warn({ reason: verified.reason }, 'Rejected Gmail OAuth callback state');
      badRequest('Invalid or expired OAuth state. Start the Gmail connection again.');
    }
    const businessId = verified.payload.b ?? undefined;
    const connectionId = await connectGmail(query.code, businessId);
    await enqueue('gmail.sync', { connectionId });
    await enqueue('gmail.backfill', { connectionId, daysRequested: GMAIL_BACKFILL_DAYS });
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
    if (body.businessId) await resumeBlockedPlaidSync(row.id);
    return toApiConnection(row);
  });

  app.patch('/connections/:id', async (request) => {
    const user = await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ label: z.string().trim().min(1).max(80) }).parse(request.body);
    const [row] = await db
      .update(connections)
      .set({ label: body.label, labelUserSet: true, updatedAt: new Date() })
      .where(eq(connections.id, params.id))
      .returning();
    if (!row) notFound('Connection not found');
    await audit(request, user, 'rename_connection', 'connection', params.id, { label: body.label });
    return toApiConnection(row);
  });

  app.delete('/connections/:id', async (request, reply) => {
    const user = await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const existing = await db.query.connections.findFirst({ where: eq(connections.id, params.id) });
    if (!existing) notFound('Connection not found');
    const isPlaid = existing.kind !== 'gmail';
    // Best-effort: revoke the Item at Plaid so it stops billing. Never blocks the disconnect.
    if (isPlaid) await removePlaidItem(existing.encryptedAccessToken);
    const [row] = await db
      .update(connections)
      .set({
        status: 'disconnected',
        ...(isPlaid ? { encryptedAccessToken: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(connections.id, params.id))
      .returning();
    if (!row) notFound('Connection not found');
    await db.update(accounts).set({ enabled: false, updatedAt: new Date() }).where(eq(accounts.connectionId, params.id));
    await audit(request, user, 'disconnect_connection', 'connection', params.id);
    return reply.status(204).send();
  });
}
