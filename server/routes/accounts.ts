import type { FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireUser } from '../auth/session.js';
import { db } from '../db/client.js';
import { accounts, businesses, connections, transactions } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { audit } from '../services/audit.js';

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.get('/accounts', async (request) => {
    await requireUser(request);
    const query = z.object({ biz: z.string().optional() }).parse(request.query);
    const rows = await db
      .select({
        id: accounts.id,
        connectionId: accounts.connectionId,
        businessId: accounts.businessId,
        businessKey: businesses.key,
        plaidAccountId: accounts.plaidAccountId,
        kind: accounts.kind,
        name: accounts.name,
        nickname: accounts.nickname,
        officialName: accounts.officialName,
        mask: accounts.mask,
        enabled: accounts.enabled,
        currentBalanceCents: accounts.currentBalanceCents,
        availableBalanceCents: accounts.availableBalanceCents,
        connectionLabel: connections.label,
        connectionStatus: connections.status,
      })
      .from(accounts)
      .innerJoin(connections, eq(accounts.connectionId, connections.id))
      .leftJoin(businesses, eq(accounts.businessId, businesses.id))
      .where(and(
        query.biz && query.biz !== 'all' ? eq(businesses.key, query.biz) : sql`true`,
        sql`${connections.status} <> 'disconnected'`,
      ))
      .orderBy(accounts.name);
    return rows.map((row) => ({
      ...row,
      mask: row.mask ? `•• ${row.mask.replace(/^••\s*/, '')}` : null,
      biz: row.businessKey ?? 'all',
    }));
  });

  app.patch('/accounts/:id/business', async (request) => {
    const actor = await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({
      businessId: z.string().uuid().nullable(),
      applyToExisting: z.boolean().default(false),
    }).parse(request.body);

    if (body.businessId) {
      const business = await db.query.businesses.findFirst({ where: eq(businesses.id, body.businessId) });
      if (!business) notFound('Business not found');
    }

    const [row] = await db
      .update(accounts)
      .set({ businessId: body.businessId, updatedAt: new Date() })
      .where(eq(accounts.id, params.id))
      .returning();
    if (!row) notFound('Account not found');

    if (body.applyToExisting && body.businessId) {
      await db
        .update(transactions)
        .set({ businessId: body.businessId, updatedAt: new Date() })
        .where(eq(transactions.accountId, params.id));
    }

    await audit(request, actor, 'update_account_business', 'account', params.id, body);
    return row;
  });

  app.patch('/accounts/:id/nickname', async (request) => {
    const actor = await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ nickname: z.string().trim().max(80).nullable() }).parse(request.body);
    const normalized = body.nickname && body.nickname.length > 0 ? body.nickname : null;
    const [row] = await db
      .update(accounts)
      .set({ nickname: normalized, updatedAt: new Date() })
      .where(eq(accounts.id, params.id))
      .returning();
    if (!row) notFound('Account not found');
    await audit(request, actor, 'rename_account', 'account', params.id, { nickname: normalized });
    return row;
  });

  app.patch('/accounts/:id/enabled', async (request) => {
    const actor = await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ enabled: z.boolean() }).parse(request.body);
    const [row] = await db
      .update(accounts)
      .set({ enabled: body.enabled, updatedAt: new Date() })
      .where(eq(accounts.id, params.id))
      .returning();
    if (!row) notFound('Account not found');
    await audit(request, actor, body.enabled ? 'enable_account' : 'disable_account', 'account', params.id);
    return row;
  });
}
