import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, ilike, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireUser } from '../../auth/session.js';
import { db } from '../../db/client.js';
import { accounts, alerts, businesses, categories, connections, transactions } from '../../db/schema.js';
import { notFound } from '../../lib/errors.js';
import { audit } from '../../services/audit.js';
import { listCategorizationReviewItems, resolveCategorizationReviewItem } from '../../services/categorizationFeedback.js';
import {
  toApiAlert,
  toApiBusiness,
  toApiCategorizationReviewItem,
  toApiCategory,
  toApiConnection,
} from '../mappers.js';
import {
  categoryIsVisibleSpend,
  dateWindow,
  joinedTransactionSpendFilter,
  parseAccountIds,
  spendCategoryFilter,
} from './helpers.js';
import { connectionHealthById } from './connectionHealth.js';

export function registerReferenceRoutes(app: FastifyInstance): void {
  app.get('/businesses', async (request) => {
    await requireUser(request);
    const rows = await db.select().from(businesses).where(eq(businesses.active, true)).orderBy(businesses.name);
    return rows.map(toApiBusiness);
  });

  app.get('/categories', async (request) => {
    await requireUser(request);
    const query = z.object({
      period: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      biz: z.string().optional(),
      q: z.string().optional(),
      accounts: z.string().optional(),
    }).parse(request.query);
    const accountIds = parseAccountIds(query.accounts);
    const { from, to } = dateWindow(query.period, query.from, query.to);
    const selectedBusiness = query.biz && query.biz !== 'all'
      ? await db.query.businesses.findFirst({ where: eq(businesses.key, query.biz) })
      : null;
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
        spendCategoryFilter(),
        selectedBusiness ? eq(transactions.businessId, selectedBusiness.id) : sql`true`,
      ))
      .leftJoin(accounts, eq(transactions.accountId, accounts.id))
      .where(and(
        eq(categories.active, true),
        categoryIsVisibleSpend(),
        selectedBusiness ? or(eq(categories.businessId, selectedBusiness.id), sql`${categories.businessId} IS NULL`) : sql`true`,
        joinedTransactionSpendFilter(accountIds),
        query.q ? ilike(categories.name, `%${query.q}%`) : sql`true`,
      ))
      .groupBy(categories.id)
      .orderBy(sql`coalesce(abs(sum(${transactions.amountCents})), 0) desc`);
    const merged = new Map<string, typeof rows[number] & { amountCents: number; count: number; delta: string }>();
    for (const row of rows) {
      const existing = merged.get(row.name);
      if (existing) {
        existing.amountCents += Number(row.amountCents ?? 0);
        existing.count += Number(row.count ?? 0);
      } else {
        merged.set(row.name, {
          ...row,
          amountCents: Number(row.amountCents ?? 0),
          count: Number(row.count ?? 0),
          delta: '+0%',
        });
      }
    }
    return Array.from(merged.values())
      .sort((a, b) => b.amountCents - a.amountCents)
      .map((row) => toApiCategory(row));
  });

  app.get('/connections', async (request) => {
    await requireUser(request);
    const query = z.object({ biz: z.string().optional() }).parse(request.query);
    const rows = await db
      .select({ connection: connections, businessKey: businesses.key })
      .from(connections)
      .leftJoin(businesses, eq(connections.businessId, businesses.id))
      .where(and(
        query.biz && query.biz !== 'all' ? eq(businesses.key, query.biz) : sql`true`,
        sql`${connections.status} <> 'disconnected'`,
      ))
      .orderBy(connections.kind, connections.label);
    const health = await connectionHealthById(rows.map((row) => row.connection));
    return rows.map((row) => toApiConnection(row.connection, row.businessKey ?? undefined, health.get(row.connection.id)));
  });

  app.get('/alerts', async (request) => {
    await requireUser(request);
    const query = z.object({ status: z.enum(['open', 'dismissed']).optional(), biz: z.string().optional() }).parse(request.query);
    const rows = await db
      .select({ alert: alerts })
      .from(alerts)
      .leftJoin(businesses, eq(alerts.businessId, businesses.id))
      .where(and(
        eq(alerts.status, query.status ?? 'open'),
        query.biz && query.biz !== 'all' ? eq(businesses.key, query.biz) : sql`true`,
      ))
      .orderBy(desc(alerts.createdAt));
    return rows.map((row) => toApiAlert(row.alert));
  });

  app.post('/alerts/:id/dismiss', async (request, reply) => {
    await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    await db.update(alerts).set({ status: 'dismissed', dismissedAt: new Date() }).where(eq(alerts.id, params.id));
    return reply.status(204).send();
  });

  app.get('/categorization/review-items', async (request) => {
    await requireUser(request);
    const query = z.object({
      status: z.enum(['open', 'accepted', 'dismissed', 'expired']).optional(),
      biz: z.string().optional(),
    }).parse(request.query);
    const rows = await listCategorizationReviewItems({
      status: query.status ?? 'open',
      businessKey: query.biz,
    });
    return rows.map(toApiCategorizationReviewItem);
  });

  app.post('/categorization/review-items/:id/resolve', async (request) => {
    const user = await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ action: z.enum(['accept', 'dismiss']) }).parse(request.body);
    const result = await resolveCategorizationReviewItem({
      id: params.id,
      action: body.action,
      userId: user.id,
    });
    if (!result) notFound('Review item not found');
    await audit(request, user, 'resolve_categorization_review_item', 'categorization_review_item', params.id, {
      action: body.action,
      appliedCount: result.appliedCount,
      conflictCount: result.conflictCount,
    });
    return {
      item: toApiCategorizationReviewItem(result.item as any),
      appliedCount: result.appliedCount,
      conflictCount: result.conflictCount,
    };
  });
}
