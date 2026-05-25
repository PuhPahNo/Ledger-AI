import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, getTableColumns, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireUser } from '../auth/session.js';
import { db } from '../db/client.js';
import { accounts, alerts, businesses, categories, connections, transactions } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import { isIncomeCategory } from '../services/categorization.js';
import {
  createManualCategorizationFeedback,
  listCategorizationReviewItems,
  resolveCategorizationReviewItem,
} from '../services/categorizationFeedback.js';
import { normalizeTransactionOverride } from '../services/transactionOverrides.js';
import {
  toApiAlert,
  toApiBusiness,
  toApiCategorizationReviewItem,
  toApiCategory,
  toApiConnection,
  toApiTransaction,
} from './mappers.js';

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
      accounts: z.string().optional(),
      categories: z.string().optional(),
      receipts: z.string().optional(),
      sort: z.enum(['date', 'amount', 'merchant', 'business', 'category', 'account']).default('date'),
      dir: z.enum(['asc', 'desc']).default('desc'),
    }).parse(request.query);
    const accountIds = parseAccountIds(query.accounts);
    const categoryNames = parseList(query.categories);
    const receiptStatuses = parseList(query.receipts).filter(isReceiptStatus);
    const sortColumn = transactionSortColumn(query.sort);
    const sortDirection = query.dir === 'asc' ? asc : desc;

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
        categorySource: transactions.categorySource,
        categoryConfidence: transactions.categoryConfidence,
        categoryEvidence: transactions.categoryEvidence,
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
        categoryTaxCode: categories.taxCode,
      })
      .from(transactions)
      .innerJoin(businesses, eq(transactions.businessId, businesses.id))
      .leftJoin(categories, eq(transactions.categoryId, categories.id))
      .leftJoin(accounts, eq(transactions.accountId, accounts.id))
      .where(and(
        query.biz && query.biz !== 'all' ? eq(businesses.key, query.biz) : sql`true`,
        query.from ? gte(transactions.date, query.from) : sql`true`,
        query.to ? lte(transactions.date, query.to) : sql`true`,
        accountSpendFilter(accountIds),
        categoryNames.length ? inArray(categories.name, categoryNames) : sql`true`,
        receiptStatuses.length ? inArray(transactions.receiptStatus, receiptStatuses) : sql`true`,
        query.q ? or(
          ilike(transactions.merchant, `%${query.q}%`),
          ilike(transactions.sourceLabel, `%${query.q}%`),
          ilike(transactions.note, `%${query.q}%`),
          ilike(categories.name, `%${query.q}%`),
        ) : sql`true`,
      ))
      .orderBy(sortDirection(sortColumn), desc(transactions.createdAt))
      .limit(Math.min(query.limit ?? 100, 2000));
    return rows.map(toApiTransaction);
  });

  app.patch('/transactions/:id', async (request) => {
    const user = await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = normalizeTransactionOverride(z.object({
      businessId: z.string().uuid().optional(),
      categoryId: z.string().uuid().nullable().optional(),
      note: z.string().nullable().optional(),
    }).parse(request.body));

    if (body.businessId) {
      const business = await db.query.businesses.findFirst({ where: eq(businesses.id, body.businessId) });
      if (!business) notFound('Business not found');
    }
    let selectedCategory: typeof categories.$inferSelect | undefined;
    if (body.categoryId) {
      selectedCategory = await db.query.categories.findFirst({ where: eq(categories.id, body.categoryId) });
      if (!selectedCategory) notFound('Category not found');
    }

    const previous = await db.query.transactions.findFirst({ where: eq(transactions.id, params.id) });
    if (!previous) notFound('Transaction not found');

    const categoryProvenance = body.categoryId !== undefined
      ? body.categoryId
        ? {
            categorySource: 'manual' as const,
            categoryConfidence: '1.0000',
            categoryEvidence: { source: 'transaction_drawer' },
          }
        : {
            categorySource: 'uncategorized' as const,
            categoryConfidence: null,
            categoryEvidence: {},
          }
      : {};

    const [updated] = await db
      .update(transactions)
      .set({ ...body, ...categoryProvenance, updatedAt: new Date() })
      .where(eq(transactions.id, params.id))
      .returning();
    if (!updated) notFound('Transaction not found');
    if (
      body.categoryId
      && updated.categoryId
      && updated.amountCents < 0
      && selectedCategory
      && !isIncomeCategory(selectedCategory)
      && previous.categoryId !== updated.categoryId
    ) {
      await createManualCategorizationFeedback({
        transaction: updated,
        previousCategoryId: previous.categoryId,
        newCategoryId: updated.categoryId,
        userId: user.id,
      });
    }
    await audit(request, user, 'update_transaction', 'transaction', params.id, { ...body });

    const row = await transactionById(params.id);
    if (!row) notFound('Transaction not found');
    return toApiTransaction(row as any);
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
        categoryTaxCode: categories.taxCode,
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
    return rows.map((row) => toApiConnection(row.connection, row.businessKey ?? undefined));
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

  app.get('/insights/category-comparison', async (request) => {
    await requireUser(request);
    const query = z.object({
      period: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      biz: z.string().optional(),
      basis: z.enum(['month', 'year']).default('month'),
      q: z.string().optional(),
      accounts: z.string().optional(),
    }).parse(request.query);
    const accountIds = parseAccountIds(query.accounts);
    const period = query.period ?? new Date().toISOString().slice(0, 7);
    const window = query.from && query.to
      ? comparisonWindowForRange(query.from, query.to, query.basis)
      : comparisonWindow(period, query.basis);
    const selectedBusiness = query.biz && query.biz !== 'all'
      ? await db.query.businesses.findFirst({ where: eq(businesses.key, query.biz) })
      : null;
    const rows = await db.execute(sql`
      WITH category_totals AS (
        SELECT coalesce(${categories.name}, 'Uncategorized') AS category,
               coalesce(abs(sum(CASE
                 WHEN ${transactions.date} >= ${window.currentFrom}
                  AND ${transactions.date} <= ${window.currentTo}
                 THEN ${transactions.amountCents}
                 ELSE 0
               END)), 0)::int AS current_cents,
               coalesce(abs(sum(CASE
                 WHEN ${transactions.date} >= ${window.previousFrom}
                  AND ${transactions.date} <= ${window.previousTo}
                 THEN ${transactions.amountCents}
                 ELSE 0
               END)), 0)::int AS previous_cents
        FROM ${transactions}
        INNER JOIN ${businesses} ON ${transactions.businessId} = ${businesses.id}
        LEFT JOIN ${categories} ON ${transactions.categoryId} = ${categories.id}
        LEFT JOIN ${accounts} ON ${transactions.accountId} = ${accounts.id}
        WHERE ${transactions.amountCents} < 0
          AND ${categoryIsVisibleSpend()}
          AND ${transactions.date} >= ${window.previousFrom}
          AND ${transactions.date} <= ${window.currentTo}
          AND ${accountSpendFilter(accountIds)}
          AND (${selectedBusiness?.id ?? null}::uuid IS NULL OR ${transactions.businessId} = ${selectedBusiness?.id ?? null}::uuid)
          AND (${query.q ?? null}::text IS NULL OR coalesce(${categories.name}, 'Uncategorized') ILIKE ${`%${query.q ?? ''}%`})
        GROUP BY coalesce(${categories.name}, 'Uncategorized')
      )
      SELECT category, current_cents, previous_cents
      FROM category_totals
      WHERE current_cents > 0 OR previous_cents > 0
      ORDER BY (current_cents + previous_cents) DESC
      LIMIT 12
    `);
    return (rows.rows as Array<{ category: string; current_cents: number; previous_cents: number }>).map((row) => ({
      category: row.category,
      currentCents: Number(row.current_cents),
      previousCents: Number(row.previous_cents),
      deltaPct: Number(row.previous_cents) > 0
        ? Math.round(((Number(row.current_cents) - Number(row.previous_cents)) / Number(row.previous_cents)) * 100)
        : 0,
    }));
  });

  app.get('/summary', async (request) => {
    await requireUser(request);
    const query = z.object({
      period: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      label: z.string().optional(),
      biz: z.string().optional(),
      accounts: z.string().optional(),
    }).parse(request.query);
    const accountIds = parseAccountIds(query.accounts);
    const period = query.period ?? new Date().toISOString().slice(0, 7);
    const { from, to, label } = dateWindow(period, query.from, query.to);
    const { priorFrom, priorTo } = previousDateWindow(from, to);
    const labels = trailingMonthWindows(to);
    const selectedBusiness = query.biz && query.biz !== 'all'
      ? await db.query.businesses.findFirst({ where: eq(businesses.key, query.biz) })
      : null;
    const businessFilter = selectedBusiness ? eq(transactions.businessId, selectedBusiness.id) : sql`true`;
    const spendFilters = [
      sql`${transactions.amountCents} < 0`,
      businessFilter,
      accountSpendFilter(accountIds),
      spendCategoryFilter(),
    ] as const;
    const [current] = await db.select({
      totalCents: sql<number>`coalesce(abs(sum(${transactions.amountCents})), 0)::int`,
    }).from(transactions)
      .leftJoin(accounts, eq(transactions.accountId, accounts.id))
      .leftJoin(categories, eq(transactions.categoryId, categories.id))
      .where(and(gte(transactions.date, from), lte(transactions.date, to), ...spendFilters));
    const [prior] = await db.select({
      totalCents: sql<number>`coalesce(abs(sum(${transactions.amountCents})), 0)::int`,
    }).from(transactions)
      .leftJoin(accounts, eq(transactions.accountId, accounts.id))
      .leftJoin(categories, eq(transactions.categoryId, categories.id))
      .where(and(gte(transactions.date, priorFrom), lte(transactions.date, priorTo), ...spendFilters));
    const trailingRows = await Promise.all(labels.map(async ({ from: monthFrom, to: monthTo }) => {
      const [row] = await db.select({
        totalCents: sql<number>`coalesce(abs(sum(${transactions.amountCents})), 0)::int`,
      }).from(transactions)
        .leftJoin(accounts, eq(transactions.accountId, accounts.id))
        .leftJoin(categories, eq(transactions.categoryId, categories.id))
        .where(and(gte(transactions.date, monthFrom), lte(transactions.date, monthTo), ...spendFilters));
      return row?.totalCents ?? 0;
    }));
    const trailingBusinessRows = await Promise.all(labels.map(async ({ from: monthFrom, to: monthTo }) => {
      const rows = await db.select({
        businessId: businesses.key,
        businessName: businesses.name,
        color: businesses.color,
        cents: sql<number>`coalesce(abs(sum(${transactions.amountCents})), 0)::int`,
      }).from(transactions)
        .innerJoin(businesses, eq(transactions.businessId, businesses.id))
        .leftJoin(accounts, eq(transactions.accountId, accounts.id))
        .leftJoin(categories, eq(transactions.categoryId, categories.id))
        .where(and(gte(transactions.date, monthFrom), lte(transactions.date, monthTo), ...spendFilters))
        .groupBy(businesses.key, businesses.name, businesses.color);
      return rows
        .map((row) => ({
          businessId: row.businessId,
          businessName: row.businessName,
          color: row.color,
          cents: Number(row.cents ?? 0),
        }))
        .filter((row) => row.cents > 0)
        .sort((a, b) => b.cents - a.cents);
    }));
    const max = Math.max(...trailingRows, 1);
    const avg = Math.round(trailingRows.reduce((sum, value) => sum + value, 0) / Math.max(trailingRows.length, 1));
    const currentTotal = current?.totalCents ?? 0;
    const priorTotal = prior?.totalCents ?? 0;
    return {
      totalCents: currentTotal,
      periodLabel: query.label ?? label,
      deltaPct: priorTotal > 0 ? Math.round(((currentTotal - priorTotal) / priorTotal) * 100) : 0,
      trailingMonths: trailingRows.map((value) => Number((value / max).toFixed(3))),
      trailingMonthCents: trailingRows.map((value) => Number(value ?? 0)),
      trailingMonthBusinessCents: trailingBusinessRows,
      trailingMonthLabels: labels.map((item) => item.label),
      lastMonthCents: priorTotal,
      avgMonthCents: avg,
    };
  });
}

function dateWindow(period?: string, from?: string, to?: string) {
  if (from && to) {
    return {
      from,
      to,
      label: rangeLabel(from, to),
    };
  }
  return monthWindow(period ?? new Date().toISOString().slice(0, 7));
}

function comparisonWindow(period: string, basis: 'month' | 'year') {
  const start = new Date(`${period}-01T00:00:00`);
  if (basis === 'year') {
    return {
      currentFrom: isoDate(new Date(start.getFullYear(), 0, 1)),
      currentTo: isoDate(new Date(start.getFullYear(), 11, 31)),
      previousFrom: isoDate(new Date(start.getFullYear() - 1, 0, 1)),
      previousTo: isoDate(new Date(start.getFullYear() - 1, 11, 31)),
    };
  }
  return {
    currentFrom: isoDate(start),
    currentTo: isoDate(new Date(start.getFullYear(), start.getMonth() + 1, 0)),
    previousFrom: isoDate(new Date(start.getFullYear(), start.getMonth() - 1, 1)),
    previousTo: isoDate(new Date(start.getFullYear(), start.getMonth(), 0)),
  };
}

function comparisonWindowForRange(from: string, to: string, basis: 'month' | 'year') {
  if (basis === 'year') {
    const start = dateFromIso(from);
    const end = dateFromIso(to);
    return {
      currentFrom: from,
      currentTo: to,
      previousFrom: isoDate(new Date(start.getFullYear() - 1, start.getMonth(), start.getDate())),
      previousTo: isoDate(new Date(end.getFullYear() - 1, end.getMonth(), end.getDate())),
    };
  }
  const previous = previousDateWindow(from, to);
  return {
    currentFrom: from,
    currentTo: to,
    previousFrom: previous.priorFrom,
    previousTo: previous.priorTo,
  };
}

async function transactionById(id: string) {
  const [row] = await db
    .select({
      ...getTableColumns(transactions),
      businessKey: businesses.key,
      categoryName: categories.name,
      categoryTaxCode: categories.taxCode,
    })
    .from(transactions)
    .innerJoin(businesses, eq(transactions.businessId, businesses.id))
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(eq(transactions.id, id))
    .limit(1);
  return row;
}

function monthWindow(period: string) {
  const start = new Date(`${period}-01T00:00:00`);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
  const priorStart = new Date(start.getFullYear(), start.getMonth() - 1, 1);
  const priorEnd = new Date(start.getFullYear(), start.getMonth(), 0);
  return {
    from: isoDate(start),
    to: isoDate(end),
    priorFrom: isoDate(priorStart),
    priorTo: isoDate(priorEnd),
    label: start.toLocaleString('en-US', { month: 'short' }).toUpperCase(),
  };
}

function previousDateWindow(from: string, to: string) {
  const start = dateFromIso(from);
  const end = dateFromIso(to);
  const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000) + 1);
  const priorEnd = new Date(start);
  priorEnd.setDate(priorEnd.getDate() - 1);
  const priorStart = new Date(priorEnd);
  priorStart.setDate(priorStart.getDate() - (days - 1));
  return {
    priorFrom: isoDate(priorStart),
    priorTo: isoDate(priorEnd),
  };
}

function trailingMonthWindows(to: string) {
  const end = dateFromIso(to);
  return Array.from({ length: 12 }, (_, index) => {
    const date = new Date(end.getFullYear(), end.getMonth() - (11 - index), 1);
    return {
      from: isoDate(date),
      to: isoDate(new Date(date.getFullYear(), date.getMonth() + 1, 0)),
      label: date.toLocaleString('en-US', { month: 'short', year: '2-digit' }),
    };
  });
}

function rangeLabel(from: string, to: string): string {
  const start = dateFromIso(from);
  const end = dateFromIso(to);
  const sameMonth = start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth();
  if (sameMonth) return start.toLocaleString('en-US', { month: 'short' }).toUpperCase();
  return `${start.toLocaleString('en-US', { month: 'short' }).toUpperCase()}-${end.toLocaleString('en-US', { month: 'short' }).toUpperCase()}`;
}

function dateFromIso(value: string): Date {
  return new Date(`${value}T00:00:00`);
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseAccountIds(value?: string): string[] {
  return parseList(value);
}

function parseList(value?: string): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function accountSpendFilter(accountIds: string[]) {
  return sql`(${transactions.accountId} IS NULL OR ${accounts.id} IS NULL OR ${accounts.enabled} = true)
    AND ${accountIds.length ? inArray(transactions.accountId, accountIds) : sql`true`}`;
}

function spendCategoryFilter() {
  return sql`${categoryIsVisibleSpend()}`;
}

function categoryIsVisibleSpend() {
  return sql`coalesce(${categories.taxCode}, '') NOT LIKE 'exclude_%'`;
}

function joinedTransactionSpendFilter(accountIds: string[]) {
  return sql`${transactions.id} IS NULL OR (${accountSpendFilter(accountIds)})`;
}

function transactionSortColumn(sort: 'date' | 'amount' | 'merchant' | 'business' | 'category' | 'account') {
  switch (sort) {
    case 'amount':
      return transactions.amountCents;
    case 'merchant':
      return transactions.merchant;
    case 'business':
      return businesses.name;
    case 'category':
      return categories.name;
    case 'account':
      return transactions.sourceLabel;
    default:
      return transactions.date;
  }
}

const receiptStatuses = ['matched', 'pending', 'missing', 'n/a'] as const;
type ReceiptStatus = typeof receiptStatuses[number];

function isReceiptStatus(value: string): value is ReceiptStatus {
  return (receiptStatuses as readonly string[]).includes(value);
}
