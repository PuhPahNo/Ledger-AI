import type { FastifyInstance } from 'fastify';
import { and, desc, eq, getTableColumns, gte, ilike, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireUser } from '../auth/session.js';
import { db } from '../db/client.js';
import { alerts, businesses, categories, connections, transactions } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { toApiAlert, toApiBusiness, toApiCategory, toApiConnection, toApiTransaction } from './mappers.js';

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/businesses', async (request) => {
    await requireUser(request);
    const rows = await db.select().from(businesses).where(eq(businesses.active, true)).orderBy(businesses.name);
    return rows.map(toApiBusiness);
  });

  app.get('/transactions', async (request) => {
    await requireUser(request);
    const query = z.object({
      biz: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      q: z.string().optional(),
      limit: z.coerce.number().optional(),
    }).parse(request.query);

    const rows = await db
      .select({
        id: transactions.id,
        businessId: transactions.businessId,
        accountId: transactions.accountId,
        plaidTransactionId: transactions.plaidTransactionId,
        date: transactions.date,
        authorizedDate: transactions.authorizedDate,
        merchant: transactions.merchant,
        amountCents: transactions.amountCents,
        categoryId: transactions.categoryId,
        receiptId: transactions.receiptId,
        receiptStatus: transactions.receiptStatus,
        sourceLabel: transactions.sourceLabel,
        note: transactions.note,
        flag: transactions.flag,
        pending: transactions.pending,
        raw: transactions.raw,
        createdAt: transactions.createdAt,
        updatedAt: transactions.updatedAt,
        businessKey: businesses.key,
        categoryName: categories.name,
      })
      .from(transactions)
      .innerJoin(businesses, eq(transactions.businessId, businesses.id))
      .leftJoin(categories, eq(transactions.categoryId, categories.id))
      .where(and(
        query.biz && query.biz !== 'all' ? eq(businesses.key, query.biz) : sql`true`,
        query.from ? gte(transactions.date, query.from) : sql`true`,
        query.to ? lte(transactions.date, query.to) : sql`true`,
        query.q ? ilike(transactions.merchant, `%${query.q}%`) : sql`true`,
      ))
      .orderBy(desc(transactions.date), desc(transactions.createdAt))
      .limit(query.limit ?? 100);
    return rows.map(toApiTransaction);
  });

  app.post('/transactions/:id/receipt', async (request) => {
    await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ receiptId: z.string().uuid() }).parse(request.body);
    const { attachReceipt } = await import('../services/matching.js');
    const updated = await attachReceipt(params.id, body.receiptId);
    if (!updated) notFound('Transaction not found');
    const row = await db
      .select({
        ...getTableColumns(transactions),
        businessKey: businesses.key,
        categoryName: categories.name,
      })
      .from(transactions)
      .innerJoin(businesses, eq(transactions.businessId, businesses.id))
      .leftJoin(categories, eq(transactions.categoryId, categories.id))
      .where(eq(transactions.id, params.id))
      .limit(1);
    return toApiTransaction(row[0] as any);
  });

  app.get('/categories', async (request) => {
    await requireUser(request);
    const query = z.object({ period: z.string().optional() }).parse(request.query);
    const period = query.period ?? new Date().toISOString().slice(0, 7);
    const from = `${period}-01`;
    const to = `${period}-31`;
    const rows = await db
      .select({
        id: categories.id,
        businessId: categories.businessId,
        name: categories.name,
        taxCode: categories.taxCode,
        color: categories.color,
        active: categories.active,
        createdAt: categories.createdAt,
        updatedAt: categories.updatedAt,
        amountCents: sql<number>`coalesce(abs(sum(${transactions.amountCents})), 0)::int`,
        count: sql<number>`count(${transactions.id})::int`,
      })
      .from(categories)
      .leftJoin(transactions, and(
        eq(transactions.categoryId, categories.id),
        gte(transactions.date, from),
        lte(transactions.date, to),
        sql`${transactions.amountCents} < 0`,
      ))
      .where(eq(categories.active, true))
      .groupBy(categories.id)
      .orderBy(sql`coalesce(abs(sum(${transactions.amountCents})), 0) desc`);
    return rows.map((row) => toApiCategory({ ...row, delta: '+0%' }));
  });

  app.get('/connections', async (request) => {
    await requireUser(request);
    const rows = await db
      .select({ connection: connections, businessKey: businesses.key })
      .from(connections)
      .leftJoin(businesses, eq(connections.businessId, businesses.id))
      .orderBy(connections.kind, connections.label);
    return rows.map((row) => toApiConnection(row.connection, row.businessKey ?? undefined));
  });

  app.get('/alerts', async (request) => {
    await requireUser(request);
    const query = z.object({ status: z.enum(['open', 'dismissed']).optional() }).parse(request.query);
    const rows = await db.select().from(alerts).where(eq(alerts.status, query.status ?? 'open')).orderBy(desc(alerts.createdAt));
    return rows.map(toApiAlert);
  });

  app.post('/alerts/:id/dismiss', async (request, reply) => {
    await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    await db.update(alerts).set({ status: 'dismissed', dismissedAt: new Date() }).where(eq(alerts.id, params.id));
    return reply.status(204).send();
  });

  app.get('/summary', async (request) => {
    await requireUser(request);
    const query = z.object({ period: z.string().optional() }).parse(request.query);
    const period = query.period ?? new Date().toISOString().slice(0, 7);
    const from = `${period}-01`;
    const to = `${period}-31`;
    const [current] = await db.select({
      totalCents: sql<number>`coalesce(abs(sum(amount_cents)), 0)::int`,
    }).from(transactions).where(and(gte(transactions.date, from), lte(transactions.date, to), sql`${transactions.amountCents} < 0`));
    return {
      totalCents: current?.totalCents ?? 0,
      periodLabel: period.slice(5, 7),
      deltaPct: 0,
      trailingMonths: [0.42, 0.38, 0.51, 0.46, 0.55, 0.61, 0.58, 0.66, 0.71, 0.68, 0.78, 0.82],
      lastMonthCents: 0,
      avgMonthCents: 0,
    };
  });
}
