import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { requireUser } from '../auth/session.js';
import { db } from '../db/client.js';
import { businesses, qboTransactions } from '../db/schema.js';
import { HttpError, badRequest, notFound } from '../lib/errors.js';
import { enqueue } from '../jobs/queue.js';
import { hasPendingQuickbooksSync } from '../jobs/scheduler.js';
import { audit } from '../services/audit.js';
import {
  completeQuickbooksConnect,
  disconnectQuickbooks,
  getQuickbooksMappings,
  linkQuickbooksTransaction,
  quickbooksStatus,
  requireQuickbooksConnection,
  requireQuickbooksConfig,
  startQuickbooksConnect,
  transactionQuickbooksDetails,
  unlinkQuickbooksTransaction,
  updateQuickbooksMappings,
  verifyQuickbooksState,
} from '../services/quickbooks.js';
import { THRESHOLD_GUIDANCE, contractorReport, necThreshold } from '../services/quickbooksContractors.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * QuickBooks Online (read-only). Every route requires an admin session; the OAuth callback also
 * requires that the signed state was issued to the same admin.
 */
export async function quickbooksRoutes(app: FastifyInstance): Promise<void> {
  app.get('/quickbooks/status', async (request) => {
    await requireUser(request);
    return quickbooksStatus();
  });

  app.post('/quickbooks/connect', async (request) => {
    const user = await requireUser(request);
    const body = z.object({ businessId: z.string().uuid() }).parse(request.body ?? {});
    const result = await startQuickbooksConnect(user.id, body.businessId);
    await audit(request, user, 'quickbooks_connect_started', 'business', body.businessId);
    return result;
  });

  // Intuit redirects the browser here (top-level GET, so the sameSite=lax session cookie is sent).
  app.get('/quickbooks/callback', async (request, reply) => {
    const user = await requireUser(request);
    const query = z.object({
      code: z.string().optional(),
      state: z.string().optional(),
      realmId: z.string().regex(/^\d{1,32}$/).optional(),
      error: z.string().optional(),
    }).parse(request.query);
    if (query.error) {
      return reply.redirect(`/?quickbooks_error=${encodeURIComponent(query.error.slice(0, 40))}`);
    }
    if (!query.code || !query.state || !query.realmId) badRequest('Missing QuickBooks authorization parameters.');
    requireQuickbooksConfig();
    const verified = verifyQuickbooksState(query.state, user.id);
    if (!verified.ok) {
      request.log.warn({ reason: verified.reason }, 'Rejected QuickBooks OAuth callback state');
      badRequest('Invalid or expired OAuth state. Start the QuickBooks connection again.');
    }
    const businessId = verified.payload.b;
    if (!businessId) badRequest('The QuickBooks connection must be started for a business.');
    try {
      const { connectionId, created } = await completeQuickbooksConnect({ code: query.code, realmId: query.realmId, businessId });
      await audit(request, user, 'connect_quickbooks', 'connection', connectionId, { businessId, realmId: query.realmId, created });
      if (!await hasPendingQuickbooksSync(connectionId)) await enqueue('quickbooks.sync', { connectionId });
      return reply.redirect('/?connected=quickbooks');
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 409) {
        return reply.redirect(`/?quickbooks_error=already_connected&message=${encodeURIComponent(error.message.slice(0, 160))}`);
      }
      throw error;
    }
  });

  app.post('/quickbooks/:connectionId/sync', async (request) => {
    const user = await requireUser(request);
    const params = z.object({ connectionId: z.string().uuid() }).parse(request.params);
    const body = z.object({ full: z.boolean().optional().default(false) }).parse(request.body ?? {});
    const { connection } = await requireQuickbooksConnection(params.connectionId);
    if (connection.status !== 'live') badRequest('Reconnect QuickBooks before syncing.');
    if (await hasPendingQuickbooksSync(params.connectionId)) return { queued: false, alreadyQueued: true };
    const jobId = await enqueue('quickbooks.sync', { connectionId: params.connectionId, full: body.full });
    await audit(request, user, 'sync_quickbooks', 'connection', params.connectionId, { full: body.full });
    return { queued: true, jobId };
  });

  app.delete('/quickbooks/:connectionId', async (request, reply) => {
    const user = await requireUser(request);
    const params = z.object({ connectionId: z.string().uuid() }).parse(request.params);
    const result = await disconnectQuickbooks(params.connectionId);
    await audit(request, user, 'disconnect_quickbooks', 'connection', params.connectionId, result);
    return reply.status(204).send();
  });

  app.get('/quickbooks/:connectionId/mappings', async (request) => {
    await requireUser(request);
    const params = z.object({ connectionId: z.string().uuid() }).parse(request.params);
    return getQuickbooksMappings(params.connectionId);
  });

  app.put('/quickbooks/:connectionId/mappings', async (request) => {
    const user = await requireUser(request);
    const params = z.object({ connectionId: z.string().uuid() }).parse(request.params);
    const body = z.object({
      bankAccounts: z.array(z.object({ qboAccountId: z.string().uuid(), ledgerAccountId: z.string().uuid().nullable() })).max(200).optional(),
      expenseAccounts: z.array(z.object({ qboAccountId: z.string().uuid(), categoryId: z.string().uuid().nullable() })).max(500).optional(),
    }).parse(request.body ?? {});
    const result = await updateQuickbooksMappings(params.connectionId, body);
    await audit(request, user, 'update_quickbooks_mappings', 'connection', params.connectionId, body);
    await enqueue('quickbooks.relink', { connectionId: params.connectionId });
    return { ...result, relinkQueued: true, mappings: await getQuickbooksMappings(params.connectionId) };
  });

  app.get('/quickbooks/contractors', async (request) => {
    await requireUser(request);
    const today = new Date().toISOString().slice(0, 10);
    const query = z.object({
      biz: z.string().optional(),
      from: isoDate.optional(),
      to: isoDate.optional(),
    }).parse(request.query);
    const to = query.to ?? today;
    const from = query.from ?? `${to.slice(0, 4)}-01-01`;
    if (from > to) badRequest('from must be on or before to');
    let businessId: string | null = null;
    if (query.biz && query.biz !== 'all') {
      const business = await db.query.businesses.findFirst({ where: eq(businesses.key, query.biz) })
        ?? (z.string().uuid().safeParse(query.biz).success ? await db.query.businesses.findFirst({ where: eq(businesses.id, query.biz) }) : undefined);
      if (!business) notFound('Business not found');
      businessId = business.id;
    }
    const year = Number(to.slice(0, 4));
    const threshold = necThreshold(year);
    return {
      from,
      to,
      threshold: { year, cents: threshold.cents, exact: threshold.exact, guidance: THRESHOLD_GUIDANCE },
      companies: await contractorReport({ businessId, from, to }),
    };
  });

  app.get('/transactions/:id/quickbooks', async (request) => {
    await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    return transactionQuickbooksDetails(params.id);
  });

  app.post('/quickbooks/links', async (request) => {
    const user = await requireUser(request);
    const body = z.object({
      transactionId: z.string().uuid(),
      qboTransactionId: z.string().uuid(),
      leg: z.enum(['main', 'from', 'to']).optional(),
    }).parse(request.body ?? {});
    const result = await linkQuickbooksTransaction({ ...body, userId: user.id });
    await audit(request, user, 'link_quickbooks_transaction', 'transaction', body.transactionId, { ...body, linkId: result.linkId });
    const qbo = await db.query.qboTransactions.findFirst({ where: eq(qboTransactions.id, body.qboTransactionId) });
    if (qbo) await enqueue('quickbooks.relink', { connectionId: qbo.connectionId });
    return transactionQuickbooksDetails(body.transactionId);
  });

  app.delete('/quickbooks/links/:linkId', async (request) => {
    const user = await requireUser(request);
    const params = z.object({ linkId: z.string().uuid() }).parse(request.params);
    const result = await unlinkQuickbooksTransaction(params.linkId);
    await audit(request, user, 'unlink_quickbooks_transaction', 'transaction', result.transactionId, { linkId: params.linkId, qboTransactionId: result.qboTransactionId });
    return transactionQuickbooksDetails(result.transactionId);
  });
}
