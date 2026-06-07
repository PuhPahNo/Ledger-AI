import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, getTableColumns, gte, ilike, inArray, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { requireUser } from '../auth/session.js';
import { db } from '../db/client.js';
import { accounts, alerts, businesses, categories, connections, exportJobs, jobs, receipts, transactions } from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import { isGmailWatchRenewalDue } from '../jobs/scheduler.js';
import { isIncomeCategory } from '../services/categorization.js';
import {
  createManualCategorizationFeedback,
  listCategorizationReviewItems,
  resolveCategorizationReviewItem,
} from '../services/categorizationFeedback.js';
import { normalizeTransactionOverride } from '../services/transactionOverrides.js';
import { getReceiptTrackingSince, getSetting, setReceiptTrackingSince, setSetting } from '../services/appSettings.js';
import {
  type ApiConnectionHealth,
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
      direction: z.enum(['all', 'inflow', 'outflow', 'operating-outflow', 'transfer']).default('all'),
      offset: z.coerce.number().int().min(0).default(0),
      sort: z.enum(['date', 'amount', 'largest', 'merchant', 'business', 'category', 'account']).default('date'),
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
        transactionDirectionFilter(query.direction),
        query.q ? or(
          ilike(transactions.merchant, `%${query.q}%`),
          ilike(transactions.sourceLabel, `%${query.q}%`),
          ilike(transactions.note, `%${query.q}%`),
          ilike(categories.name, `%${query.q}%`),
        ) : sql`true`,
      ))
      .orderBy(sortDirection(sortColumn), desc(transactions.createdAt))
      .limit(Math.min(query.limit ?? 100, 2000))
      .offset(query.offset);
    return rows.map(toApiTransaction);
  });

  app.get('/transactions/rollup', async (request) => {
    await requireUser(request);
    const query = z.object({
      biz: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      q: z.string().optional(),
      accounts: z.string().optional(),
      categories: z.string().optional(),
      receipts: z.string().optional(),
      direction: z.enum(['all', 'inflow', 'outflow', 'operating-outflow', 'transfer']).default('all'),
    }).parse(request.query);
    const accountIds = parseAccountIds(query.accounts);
    const categoryNames = parseList(query.categories);
    const receiptStatuses = parseList(query.receipts).filter(isReceiptStatus);
    const [row] = await db
      .select({
        rows: sql<number>`count(${transactions.id})::int`,
        inflowCents: sql<number>`coalesce(sum(CASE WHEN ${transactions.amountCents} > 0 THEN ${transactions.amountCents} ELSE 0 END), 0)::int`,
        outflowCents: sql<number>`coalesce(abs(sum(CASE WHEN ${transactions.amountCents} < 0 THEN ${transactions.amountCents} ELSE 0 END)), 0)::int`,
        operatingInflowCents: sql<number>`coalesce(sum(CASE WHEN ${transactions.amountCents} > 0 AND NOT (${transferCategoryFilter()}) THEN ${transactions.amountCents} ELSE 0 END), 0)::int`,
        operatingOutflowCents: sql<number>`coalesce(abs(sum(CASE WHEN ${transactions.amountCents} < 0 AND ${categoryIsVisibleSpend()} THEN ${transactions.amountCents} ELSE 0 END)), 0)::int`,
        transferCents: sql<number>`coalesce(sum(CASE WHEN ${transferCategoryFilter()} THEN abs(${transactions.amountCents}) ELSE 0 END), 0)::int`,
        netCents: sql<number>`coalesce(sum(${transactions.amountCents}), 0)::int`,
        missingReceipts: sql<number>`count(${transactions.id}) FILTER (WHERE ${transactions.receiptStatus} = 'missing')::int`,
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
        transactionDirectionFilter(query.direction),
        query.q ? or(
          ilike(transactions.merchant, `%${query.q}%`),
          ilike(transactions.sourceLabel, `%${query.q}%`),
          ilike(transactions.note, `%${query.q}%`),
          ilike(categories.name, `%${query.q}%`),
        ) : sql`true`,
      ));

    return {
      rows: Number(row?.rows ?? 0),
      inflowCents: Number(row?.inflowCents ?? 0),
      outflowCents: Number(row?.outflowCents ?? 0),
      operatingInflowCents: Number(row?.operatingInflowCents ?? 0),
      operatingOutflowCents: Number(row?.operatingOutflowCents ?? 0),
      transferCents: Number(row?.transferCents ?? 0),
      netCents: Number(row?.netCents ?? 0),
      missingReceipts: Number(row?.missingReceipts ?? 0),
    };
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
    const user = await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ receiptId: z.string().uuid() }).parse(request.body);
    const { attachReceipt } = await import('../services/matching.js');
    const updated = await attachReceipt(params.id, body.receiptId);
    if (!updated) notFound('Transaction not found');
    await audit(request, user, 'attach_receipt', 'transaction', params.id, { receiptId: body.receiptId });
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

  // Receipt-tracking cutoff: the date before which spend isn't expected to have a receipt.
  app.get('/transactions/receipt-tracking', async (request) => {
    await requireUser(request);
    const query = z.object({
      before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }).parse(request.query);
    const since = await getReceiptTrackingSince();
    let waivable = 0;
    if (query.before) {
      const [row] = await db
        .select({ count: sql<number>`count(${transactions.id})::int` })
        .from(transactions)
        .where(and(eq(transactions.receiptStatus, 'missing'), lt(transactions.date, query.before)));
      waivable = Number(row?.count ?? 0);
    }
    return { since, waivable };
  });

  // Bulk-waive missing receipts before a cutoff date, and remember that date so future imports
  // of older spend are auto-waived. Only flips 'missing' -> 'waived' (won't touch matched/n-a).
  app.post('/transactions/waive-missing', async (request) => {
    const user = await requireUser(request);
    const body = z.object({
      before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }).parse(request.body);
    const updated = await db
      .update(transactions)
      .set({ receiptStatus: 'waived', updatedAt: new Date() })
      .where(and(eq(transactions.receiptStatus, 'missing'), lt(transactions.date, body.before)))
      .returning({ id: transactions.id });
    await setReceiptTrackingSince(body.before);
    await audit(request, user, 'waive_missing_receipts', 'transaction', 'bulk', { before: body.before, count: updated.length });
    return { waived: updated.length, since: body.before };
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
      bucketPreset: z.enum(['month', 'last3', 'last12', 'ytd']).optional(),
    }).parse(request.query);
    const accountIds = parseAccountIds(query.accounts);
    const period = query.period ?? new Date().toISOString().slice(0, 7);
    const { from, to, label } = dateWindow(period, query.from, query.to);
    const { priorFrom, priorTo } = previousDateWindow(from, to);
    const labels = trailingMonthWindows(to);
    const flowWindows = flowBucketWindows(from, to, query.bucketPreset);
    const selectedBusiness = query.biz && query.biz !== 'all'
      ? await db.query.businesses.findFirst({ where: eq(businesses.key, query.biz) })
      : null;
    const businessFilter = selectedBusiness ? eq(transactions.businessId, selectedBusiness.id) : sql`true`;
    const movementFilters = [businessFilter, accountSpendFilter(accountIds)] as const;
    const spendFilters = [
      ...movementFilters,
      sql`${transactions.amountCents} < 0`,
      spendCategoryFilter(),
    ] as const;
    const inflowFilters = [
      ...movementFilters,
      sql`${transactions.amountCents} > 0`,
      // Exclude transfers so internal account-to-account moves aren't counted as income.
      // Matches the Transactions page operating-inflow definition (transfers excluded).
      sql`NOT (${transferCategoryFilter()})`,
    ] as const;
    const current = await movementSummary(from, to, spendFilters, inflowFilters);
    const prior = await movementSummary(priorFrom, priorTo, spendFilters, inflowFilters);
    const [flowRows, flowOutflowBusinessRows, flowInflowBusinessRows] = await Promise.all([
      Promise.all(flowWindows.windows.map((window) => movementSummary(window.from, window.to, spendFilters, inflowFilters))),
      Promise.all(flowWindows.windows.map(({ from: bucketFrom, to: bucketTo }) => (
        movementBusinessBreakdown(bucketFrom, bucketTo, spendFilters, sql`abs(sum(${transactions.amountCents}))`)
      ))),
      Promise.all(flowWindows.windows.map(({ from: bucketFrom, to: bucketTo }) => (
        movementBusinessBreakdown(bucketFrom, bucketTo, inflowFilters, sql`sum(${transactions.amountCents})`)
      ))),
    ]);
    const trailingRows = await Promise.all(labels.map(async ({ from: monthFrom, to: monthTo }) => {
      return movementSummary(monthFrom, monthTo, spendFilters, inflowFilters);
    }));
    const [trailingOutflowBusinessRows, trailingInflowBusinessRows] = await Promise.all([
      Promise.all(labels.map(({ from: monthFrom, to: monthTo }) => (
        movementBusinessBreakdown(monthFrom, monthTo, spendFilters, sql`abs(sum(${transactions.amountCents}))`)
      ))),
      Promise.all(labels.map(({ from: monthFrom, to: monthTo }) => (
        movementBusinessBreakdown(monthFrom, monthTo, inflowFilters, sql`sum(${transactions.amountCents})`)
      ))),
    ]);
    const trailingOutflowRows = trailingRows.map((row) => row.outflowCents);
    const trailingInflowRows = trailingRows.map((row) => row.inflowCents);
    const trailingNetRows = trailingRows.map((row) => row.netCents);
    const max = Math.max(...trailingOutflowRows, 1);
    const avgOutflow = averageCents(trailingOutflowRows);
    const avgInflow = averageCents(trailingInflowRows);
    const avgNet = averageCents(trailingNetRows);
    const currentTotal = current.outflowCents;
    const priorTotal = prior.outflowCents;
    return {
      totalCents: currentTotal,
      inflowCents: current.inflowCents,
      outflowCents: current.outflowCents,
      netCents: current.netCents,
      periodLabel: query.label ?? label,
      deltaPct: priorTotal > 0 ? Math.round(((currentTotal - priorTotal) / priorTotal) * 100) : 0,
      inflowDeltaPct: prior.inflowCents > 0 ? Math.round(((current.inflowCents - prior.inflowCents) / prior.inflowCents) * 100) : 0,
      outflowDeltaPct: priorTotal > 0 ? Math.round(((currentTotal - priorTotal) / priorTotal) * 100) : 0,
      netDeltaPct: prior.netCents !== 0 ? Math.round(((current.netCents - prior.netCents) / Math.abs(prior.netCents)) * 100) : 0,
      bucketGranularity: flowWindows.granularity,
      flowBuckets: flowWindows.windows.map((window, index) => ({
        label: window.label,
        from: window.from,
        to: window.to,
        inflowCents: flowRows[index]?.inflowCents ?? 0,
        outflowCents: flowRows[index]?.outflowCents ?? 0,
        netCents: flowRows[index]?.netCents ?? 0,
        inflowBusinessCents: flowInflowBusinessRows[index] ?? [],
        outflowBusinessCents: flowOutflowBusinessRows[index] ?? [],
      })),
      trailingMonths: trailingOutflowRows.map((value) => Number((value / max).toFixed(3))),
      trailingMonthCents: trailingOutflowRows.map((value) => Number(value ?? 0)),
      trailingMonthBusinessCents: trailingOutflowBusinessRows,
      trailingInflowMonthCents: trailingInflowRows,
      trailingOutflowMonthCents: trailingOutflowRows,
      trailingNetMonthCents: trailingNetRows,
      trailingInflowBusinessCents: trailingInflowBusinessRows,
      trailingOutflowBusinessCents: trailingOutflowBusinessRows,
      trailingMonthLabels: labels.map((item) => item.label),
      lastMonthCents: prior.outflowCents,
      lastInflowCents: prior.inflowCents,
      lastOutflowCents: prior.outflowCents,
      lastNetCents: prior.netCents,
      avgMonthCents: avgOutflow,
      avgInflowCents: avgInflow,
      avgOutflowCents: avgOutflow,
      avgNetCents: avgNet,
    };
  });

  app.get('/cash-flow', async (request) => {
    await requireUser(request);
    const query = z.object({
      from: z.string().optional(),
      to: z.string().optional(),
      group: z.enum(['month', 'year']).default('month'),
      includeTransfers: z.enum(['true', 'false']).default('false'),
      biz: z.string().optional(),
      accounts: z.string().optional(),
    }).parse(request.query);
    const to = query.to ?? isoDate(new Date());
    const from = query.from ?? isoDate(new Date(dateFromIso(to).getFullYear(), 0, 1));
    const accountIds = parseAccountIds(query.accounts);
    const includeTransfers = query.includeTransfers === 'true';
    const selectedBusiness = query.biz && query.biz !== 'all'
      ? await db.query.businesses.findFirst({ where: eq(businesses.key, query.biz) })
      : null;
    const periods = cashFlowPeriods(from, to, query.group);
    const rows = await Promise.all(periods.map(async (period) => {
      const [current, previous, businessBreakdown, previousBusinessBreakdown] = await Promise.all([
        cashFlowTotals(period.from, period.to, selectedBusiness?.id ?? null, accountIds, includeTransfers),
        cashFlowTotals(shiftIsoYear(period.from, -1), shiftIsoYear(period.to, -1), selectedBusiness?.id ?? null, accountIds, includeTransfers),
        cashFlowBusinessBreakdown(period.from, period.to, selectedBusiness?.id ?? null, accountIds, includeTransfers),
        cashFlowBusinessBreakdown(shiftIsoYear(period.from, -1), shiftIsoYear(period.to, -1), selectedBusiness?.id ?? null, accountIds, includeTransfers),
      ]);
      const previousNetByBusiness = new Map(previousBusinessBreakdown.map((row) => [row.businessId, row.netCents]));
      const netDeltaCents = current.netCents - previous.netCents;
      return {
        label: period.label,
        from: period.from,
        to: period.to,
        ...current,
        previousInflowCents: previous.inflowCents,
        previousOutflowCents: previous.outflowCents,
        previousTransferCents: previous.transferCents,
        previousNetCents: previous.netCents,
        netDeltaCents,
        netDeltaPct: previous.netCents !== 0 ? Math.round((netDeltaCents / Math.abs(previous.netCents)) * 100) : 0,
        businessBreakdown: businessBreakdown.map((row) => ({
          ...row,
          previousNetCents: previousNetByBusiness.get(row.businessId) ?? 0,
        })),
      };
    }));
    const totals = sumCashFlowPeriods(rows);
    return {
      from,
      to,
      group: query.group,
      includeTransfers,
      totals,
      periods: rows,
    };
  });

  app.get('/owner-insights', async (request) => {
    await requireUser(request);
    const query = z.object({
      from: z.string().optional(),
      to: z.string().optional(),
      biz: z.string().optional(),
      accounts: z.string().optional(),
    }).parse(request.query);
    const to = query.to ?? isoDate(new Date());
    const from = query.from ?? isoDate(new Date(dateFromIso(to).getFullYear(), dateFromIso(to).getMonth(), 1));
    const accountIds = parseAccountIds(query.accounts);
    const selectedBusiness = query.biz && query.biz !== 'all'
      ? await db.query.businesses.findFirst({ where: eq(businesses.key, query.biz) })
      : null;
    const baseFilters = [
      gte(transactions.date, from),
      lte(transactions.date, to),
      selectedBusiness ? eq(transactions.businessId, selectedBusiness.id) : sql`true`,
      accountSpendFilter(accountIds),
    ] as const;

    const [topPurchases, uncategorized, missingReceipts, transfers, incomeByBusiness, closeSummary] = await Promise.all([
      db
        .select({
          ...getTableColumns(transactions),
          businessKey: businesses.key,
          categoryName: categories.name,
          categoryTaxCode: categories.taxCode,
        })
        .from(transactions)
        .innerJoin(businesses, eq(transactions.businessId, businesses.id))
        .leftJoin(categories, eq(transactions.categoryId, categories.id))
        .leftJoin(accounts, eq(transactions.accountId, accounts.id))
        .where(and(...baseFilters, sql`${transactions.amountCents} < 0`, categoryIsVisibleSpend()))
        .orderBy(desc(sql`abs(${transactions.amountCents})`))
        .limit(12),
      db
        .select({
          count: sql<number>`count(${transactions.id})::int`,
          cents: sql<number>`coalesce(abs(sum(${transactions.amountCents})), 0)::int`,
        })
        .from(transactions)
        .leftJoin(categories, eq(transactions.categoryId, categories.id))
        .leftJoin(accounts, eq(transactions.accountId, accounts.id))
        .where(and(
          ...baseFilters,
          sql`${transactions.amountCents} < 0`,
          categoryIsVisibleSpend(),
          or(sql`${categories.id} IS NULL`, eq(categories.name, 'Uncategorized')),
        )),
      db
        .select({
          count: sql<number>`count(${transactions.id})::int`,
          cents: sql<number>`coalesce(abs(sum(${transactions.amountCents})), 0)::int`,
        })
        .from(transactions)
        .leftJoin(categories, eq(transactions.categoryId, categories.id))
        .leftJoin(accounts, eq(transactions.accountId, accounts.id))
        .where(and(...baseFilters, sql`${transactions.amountCents} < 0`, categoryIsVisibleSpend(), eq(transactions.receiptStatus, 'missing'))),
      db
        .select({
          count: sql<number>`count(${transactions.id})::int`,
          cents: sql<number>`coalesce(sum(abs(${transactions.amountCents})), 0)::int`,
        })
        .from(transactions)
        .leftJoin(categories, eq(transactions.categoryId, categories.id))
        .leftJoin(accounts, eq(transactions.accountId, accounts.id))
        .where(and(...baseFilters, transferCategoryFilter())),
      db
        .select({
          businessId: businesses.key,
          businessName: businesses.name,
          color: businesses.color,
          cents: sql<number>`coalesce(sum(${transactions.amountCents}), 0)::int`,
          count: sql<number>`count(${transactions.id})::int`,
        })
        .from(transactions)
        .innerJoin(businesses, eq(transactions.businessId, businesses.id))
        .leftJoin(categories, eq(transactions.categoryId, categories.id))
        .leftJoin(accounts, eq(transactions.accountId, accounts.id))
        // Inflow by business: any positive cash that isn't an internal transfer (so Revenue counts).
        .where(and(...baseFilters, sql`${transactions.amountCents} > 0`, sql`NOT (${transferCategoryFilter()})`))
        .groupBy(businesses.key, businesses.name, businesses.color)
        .orderBy(desc(sql`sum(${transactions.amountCents})`)),
      db
        .select({
          transactionCount: sql<number>`count(${transactions.id})::int`,
          // Inflow = all non-transfer positives (includes Revenue).
          inflowCents: sql<number>`coalesce(sum(CASE WHEN ${transactions.amountCents} > 0 AND NOT (${transferCategoryFilter()}) THEN ${transactions.amountCents} ELSE 0 END), 0)::int`,
          // Outflow = operating spend only (transfers excluded).
          outflowCents: sql<number>`coalesce(abs(sum(CASE WHEN ${transactions.amountCents} < 0 AND ${categoryIsVisibleSpend()} THEN ${transactions.amountCents} ELSE 0 END)), 0)::int`,
          // Net = inflow − outflow, both computed under the same exclusions as above.
          netCents: sql<number>`coalesce(sum(CASE WHEN ${transactions.amountCents} > 0 AND NOT (${transferCategoryFilter()}) THEN ${transactions.amountCents} WHEN ${transactions.amountCents} < 0 AND ${categoryIsVisibleSpend()} THEN ${transactions.amountCents} ELSE 0 END), 0)::int`,
        })
        .from(transactions)
        .leftJoin(categories, eq(transactions.categoryId, categories.id))
        .leftJoin(accounts, eq(transactions.accountId, accounts.id))
        .where(and(...baseFilters)),
    ]);

    return {
      from,
      to,
      topPurchases: topPurchases.map((row) => toApiTransaction(row as any)),
      uncategorized: normalizeInsightMetric(uncategorized[0]),
      missingReceipts: normalizeInsightMetric(missingReceipts[0]),
      transfers: normalizeInsightMetric(transfers[0]),
      incomeByBusiness: incomeByBusiness.map((row) => ({
        businessId: row.businessId,
        businessName: row.businessName,
        color: row.color,
        cents: Number(row.cents ?? 0),
        count: Number(row.count ?? 0),
      })),
      closeSummary: {
        inflowCents: Number(closeSummary[0]?.inflowCents ?? 0),
        outflowCents: Number(closeSummary[0]?.outflowCents ?? 0),
        netCents: Number(closeSummary[0]?.netCents ?? 0),
        transactionCount: Number(closeSummary[0]?.transactionCount ?? 0),
      },
    };
  });

  app.get('/close-readiness', async (request) => {
    await requireUser(request);
    const query = z.object({
      from: z.string().optional(),
      to: z.string().optional(),
      biz: z.string().optional(),
      accounts: z.string().optional(),
    }).parse(request.query);
    const to = query.to ?? isoDate(new Date());
    const from = query.from ?? isoDate(new Date(dateFromIso(to).getFullYear(), dateFromIso(to).getMonth(), 1));
    const accountIds = parseAccountIds(query.accounts);
    return buildCloseReadiness({ from, to, biz: query.biz, accountIds });
  });

  app.post('/close-readiness/sign-off', async (request) => {
    const user = await requireUser(request);
    const body = z.object({
      from: z.string(),
      to: z.string(),
      biz: z.string().optional(),
      accounts: z.array(z.string()).optional().default([]),
    }).parse(request.body);
    const readiness = await buildCloseReadiness({
      from: body.from,
      to: body.to,
      biz: body.biz,
      accountIds: body.accounts,
    });
    if (!readiness.canSignOff) badRequest('Period still has close blockers.');
    const signedOffAt = new Date().toISOString();
    await setSetting(closeSignoffKey(readiness.biz, readiness.from, readiness.to), JSON.stringify({
      signedOffAt,
      signedOffByUserId: user.id,
    }));
    await audit(request, user, 'sign_off_close_period', 'close_period', `${readiness.biz}:${readiness.from}:${readiness.to}`, {
      from: readiness.from,
      to: readiness.to,
      biz: readiness.biz,
    });
    return {
      ...readiness,
      signedOff: true,
      signedOffAt,
      canSignOff: false,
      items: readiness.items.filter((item) => item.id !== 'sign-off'),
    };
  });
}

function normalizeInsightMetric(row?: { count?: number | null; cents?: number | null }) {
  return {
    count: Number(row?.count ?? 0),
    cents: Number(row?.cents ?? 0),
  };
}

async function buildCloseReadiness(input: {
  from: string;
  to: string;
  biz?: string;
  accountIds: string[];
}) {
  const selectedBusiness = input.biz && input.biz !== 'all'
    ? await db.query.businesses.findFirst({ where: eq(businesses.key, input.biz) })
    : null;
  const biz = selectedBusiness?.key ?? 'all';
  const baseTransactionFilters = [
    gte(transactions.date, input.from),
    lte(transactions.date, input.to),
    selectedBusiness ? eq(transactions.businessId, selectedBusiness.id) : sql`true`,
    accountSpendFilter(input.accountIds),
  ] as const;
  const [missingReceipts, uncategorized, transfers, unmatchedReceipts, reviewItems, exportRows] = await Promise.all([
    db.select({
      count: sql<number>`count(${transactions.id})::int`,
      cents: sql<number>`coalesce(abs(sum(${transactions.amountCents})), 0)::int`,
    }).from(transactions)
      .leftJoin(categories, eq(transactions.categoryId, categories.id))
      .leftJoin(accounts, eq(transactions.accountId, accounts.id))
      .where(and(...baseTransactionFilters, sql`${transactions.amountCents} < 0`, categoryIsVisibleSpend(), eq(transactions.receiptStatus, 'missing'))),
    db.select({
      count: sql<number>`count(${transactions.id})::int`,
      cents: sql<number>`coalesce(abs(sum(${transactions.amountCents})), 0)::int`,
    }).from(transactions)
      .leftJoin(categories, eq(transactions.categoryId, categories.id))
      .leftJoin(accounts, eq(transactions.accountId, accounts.id))
      .where(and(...baseTransactionFilters, sql`${transactions.amountCents} < 0`, categoryIsVisibleSpend(), or(sql`${categories.id} IS NULL`, eq(categories.name, 'Uncategorized')))),
    db.select({
      count: sql<number>`count(${transactions.id})::int`,
      cents: sql<number>`coalesce(sum(abs(${transactions.amountCents})), 0)::int`,
    }).from(transactions)
      .leftJoin(categories, eq(transactions.categoryId, categories.id))
      .leftJoin(accounts, eq(transactions.accountId, accounts.id))
      .where(and(...baseTransactionFilters, transferCategoryFilter())),
    db.select({
      count: sql<number>`count(${receipts.id})::int`,
    }).from(receipts)
      .leftJoin(businesses, eq(receipts.businessId, businesses.id))
      .where(and(
        selectedBusiness ? eq(receipts.businessId, selectedBusiness.id) : sql`true`,
        eq(receipts.status, 'pending'),
        isNull(receipts.transactionId),
        or(
          isNull(receipts.receiptDate),
          and(gte(receipts.receiptDate, input.from), lte(receipts.receiptDate, input.to)),
        )!,
      )),
    listCategorizationReviewItems({ status: 'open', businessKey: input.biz }),
    db.select().from(exportJobs).where(and(
      eq(exportJobs.dateFrom, input.from),
      eq(exportJobs.dateTo, input.to),
      selectedBusiness ? eq(exportJobs.businessId, selectedBusiness.id) : sql`${exportJobs.businessId} IS NULL`,
    )).orderBy(desc(exportJobs.createdAt)).limit(1),
  ]);

  const failedSyncCount = await failedSyncCountForBusiness(selectedBusiness?.id ?? null);
  const items = [
    closeItem({
      id: 'missing-receipts',
      label: `${normalizeInsightMetric(missingReceipts[0]).count} missing receipt${normalizeInsightMetric(missingReceipts[0]).count === 1 ? '' : 's'}`,
      detail: `${formatCentsForClose(normalizeInsightMetric(missingReceipts[0]).cents)} of operating outflow still needs documentation.`,
      severity: 'blocker',
      metric: normalizeInsightMetric(missingReceipts[0]),
      actionView: 'transactions',
      filters: { from: input.from, to: input.to, receipts: ['missing'], direction: 'operating-outflow', biz },
    }),
    closeItem({
      id: 'unmatched-receipts',
      label: `${Number(unmatchedReceipts[0]?.count ?? 0)} unmatched receipt${Number(unmatchedReceipts[0]?.count ?? 0) === 1 ? '' : 's'}`,
      detail: 'Receipts are waiting for transaction pairing or dismissal.',
      severity: 'blocker',
      count: Number(unmatchedReceipts[0]?.count ?? 0),
      actionView: 'receipts',
      filters: { source: 'all', biz },
    }),
    closeItem({
      id: 'uncategorized',
      label: `${normalizeInsightMetric(uncategorized[0]).count} uncategorized transaction${normalizeInsightMetric(uncategorized[0]).count === 1 ? '' : 's'}`,
      detail: `${formatCentsForClose(normalizeInsightMetric(uncategorized[0]).cents)} needs category review.`,
      severity: 'blocker',
      metric: normalizeInsightMetric(uncategorized[0]),
      actionView: 'transactions',
      filters: { from: input.from, to: input.to, categories: ['Uncategorized'], direction: 'operating-outflow', biz },
    }),
    closeItem({
      id: 'sync-failures',
      label: `${failedSyncCount} failed sync${failedSyncCount === 1 ? '' : 's'}`,
      detail: 'Resolve failed provider jobs or reauth prompts before signing off.',
      severity: 'blocker',
      count: failedSyncCount,
      actionView: 'admin',
      filters: { tab: 'connections' },
    }),
    closeItem({
      id: 'category-reviews',
      label: `${reviewItems.length} rule/category review${reviewItems.length === 1 ? '' : 's'}`,
      detail: 'Open suggestions should be accepted or dismissed before close.',
      severity: 'blocker',
      count: reviewItems.length,
      actionView: 'admin',
      filters: { tab: 'rules' },
    }),
    closeItem({
      id: 'transfers',
      label: `${normalizeInsightMetric(transfers[0]).count} transfer${normalizeInsightMetric(transfers[0]).count === 1 ? '' : 's'} to audit`,
      detail: `${formatCentsForClose(normalizeInsightMetric(transfers[0]).cents)} of transfer movement is visible for review.`,
      severity: 'review',
      metric: normalizeInsightMetric(transfers[0]),
      actionView: 'transactions',
      filters: { from: input.from, to: input.to, direction: 'transfer', biz },
    }),
  ].filter((item): item is NonNullable<typeof item> => Boolean(item));

  const exportJob = exportRows[0];
  items.push({
    id: 'export',
    label: exportJob ? `Export ${exportJob.status}` : 'Queue audit export',
    detail: exportJob
      ? 'An audit export exists for this period.'
      : 'Queue an audit export from Admin after the blocking items are clear.',
    severity: 'ready',
    count: exportJob ? 1 : 0,
    cents: undefined,
    actionView: 'admin',
    filters: { tab: 'exports' },
  });

  const signoff = await readCloseSignoff(biz, input.from, input.to);
  const blockers = items.filter((item) => item.severity === 'blocker' && item.count > 0);
  const canSignOff = blockers.length === 0 && !signoff.signedOff;
  if (canSignOff) {
    items.push({
      id: 'sign-off',
      label: 'Sign off period close',
      detail: 'All blocking close items are clear.',
      severity: 'ready',
      count: 1,
      cents: undefined,
      actionView: 'insights',
      filters: { from: input.from, to: input.to, biz },
    });
  }
  return {
    from: input.from,
    to: input.to,
    biz,
    signedOff: signoff.signedOff,
    signedOffAt: signoff.signedOffAt,
    canSignOff,
    items,
  };
}

function closeItem(input: {
  id: string;
  label: string;
  detail: string;
  severity: 'blocker' | 'review' | 'ready';
  metric?: { count: number; cents: number };
  count?: number;
  actionView: 'dashboard' | 'transactions' | 'receipts' | 'cash-flow' | 'balances' | 'insights' | 'assistant' | 'admin';
  filters?: Record<string, string | string[] | boolean | null>;
}) {
  const count = input.metric?.count ?? input.count ?? 0;
  if (count <= 0 && input.severity !== 'ready') return null;
  return {
    id: input.id,
    label: input.label,
    detail: input.detail,
    severity: input.severity,
    count,
    cents: input.metric?.cents,
    actionView: input.actionView,
    filters: input.filters,
  };
}

async function failedSyncCountForBusiness(businessId: string | null): Promise<number> {
  const connectionRows = await db
    .select({ id: connections.id, status: connections.status })
    .from(connections)
    .where(and(
      sql`${connections.status} <> 'disconnected'`,
      businessId ? eq(connections.businessId, businessId) : sql`true`,
    ));
  const connectionIds = connectionRows.map((row) => row.id);
  if (!connectionIds.length) return 0;
  const [row] = await db
    .select({ count: sql<number>`count(${jobs.id})::int` })
    .from(jobs)
    .where(and(
      eq(jobs.status, 'failed'),
      or(...connectionIds.map((id) => sql`${jobs.payload} ->> 'connectionId' = ${id}`))!,
    ));
  return Number(row?.count ?? 0) + connectionRows.filter((connection) => connection.status === 'reauth').length;
}

async function readCloseSignoff(biz: string, from: string, to: string): Promise<{ signedOff: boolean; signedOffAt: string | null }> {
  const raw = await getSetting(closeSignoffKey(biz, from, to));
  if (!raw) return { signedOff: false, signedOffAt: null };
  try {
    const parsed = JSON.parse(raw) as { signedOffAt?: unknown };
    return { signedOff: true, signedOffAt: typeof parsed.signedOffAt === 'string' ? parsed.signedOffAt : null };
  } catch {
    return { signedOff: true, signedOffAt: null };
  }
}

function closeSignoffKey(biz: string, from: string, to: string): string {
  return `close_signoff:${biz}:${from}:${to}`;
}

function formatCentsForClose(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cents / 100);
}

async function connectionHealthById(connectionRows: Array<typeof connections.$inferSelect>): Promise<Map<string, ApiConnectionHealth>> {
  const map = new Map<string, ApiConnectionHealth>();
  const ids = connectionRows.map((row) => row.id);
  const jobRows = ids.length
    ? await db
      .select()
      .from(jobs)
      .where(or(...ids.map((id) => sql`${jobs.payload} ->> 'connectionId' = ${id}`))!)
      .orderBy(desc(jobs.createdAt))
      .limit(Math.max(100, ids.length * 20))
    : [];
  const jobsByConnection = new Map<string, typeof jobRows>();
  for (const job of jobRows) {
    const connectionId = typeof job.payload.connectionId === 'string' ? job.payload.connectionId : null;
    if (!connectionId) continue;
    const list = jobsByConnection.get(connectionId) ?? [];
    list.push(job);
    jobsByConnection.set(connectionId, list);
  }

  for (const connection of connectionRows) {
    const metadata = connection.metadata ?? {};
    const relatedJobs = jobsByConnection.get(connection.id) ?? [];
    const lastJob = relatedJobs[0];
    map.set(connection.id, {
      lastSyncAt: connection.lastSyncAt?.toISOString() ?? null,
      lastWebhookAt: stringOrNull(metadata.lastWebhookAt),
      lastPubSubAt: stringOrNull(metadata.lastPubSubAt),
      gmailWatchExpiration: connection.gmailWatchExpiration?.toISOString() ?? null,
      gmailWatchRenewalDue: connection.kind === 'gmail'
        ? isGmailWatchRenewalDue(connection.gmailWatchExpiration ?? null)
        : false,
      lastJobType: lastJob?.type ?? null,
      lastJobStatus: lastJob?.status ?? null,
      lastJobAt: lastJob?.updatedAt.toISOString() ?? lastJob?.createdAt.toISOString() ?? null,
      lastJobError: lastJob?.lastError ?? null,
      queuedJobCount: relatedJobs.filter((job) => job.status === 'queued' || job.status === 'running').length,
      failedJobCount: relatedJobs.filter((job) => job.status === 'failed').length,
      actions: {
        canSync: connection.status === 'live',
        canBackfill: connection.status === 'live',
        gmailBackfillDays: connection.kind === 'gmail' ? [7, 30, 90, 365] : [],
        plaidBackfillMonths: connection.kind === 'gmail' ? [] : [12],
      },
    });
  }
  return map;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

interface MovementSummaryCents {
  inflowCents: number;
  outflowCents: number;
  netCents: number;
}

async function movementSummary(
  from: string,
  to: string,
  spendFilters: readonly SQL[],
  inflowFilters: readonly SQL[],
): Promise<MovementSummaryCents> {
  const [[outflow], [inflow]] = await Promise.all([
    db.select({
      cents: sql<number>`coalesce(abs(sum(${transactions.amountCents})), 0)::int`,
    }).from(transactions)
      .leftJoin(accounts, eq(transactions.accountId, accounts.id))
      .leftJoin(categories, eq(transactions.categoryId, categories.id))
      .where(and(gte(transactions.date, from), lte(transactions.date, to), ...spendFilters)),
    db.select({
      cents: sql<number>`coalesce(sum(${transactions.amountCents}), 0)::int`,
    }).from(transactions)
      .leftJoin(accounts, eq(transactions.accountId, accounts.id))
      .leftJoin(categories, eq(transactions.categoryId, categories.id))
      .where(and(gte(transactions.date, from), lte(transactions.date, to), ...inflowFilters)),
  ]);
  const inflowCents = Number(inflow?.cents ?? 0);
  const outflowCents = Number(outflow?.cents ?? 0);
  return {
    inflowCents,
    outflowCents,
    netCents: inflowCents - outflowCents,
  };
}

async function movementBusinessBreakdown(
  from: string,
  to: string,
  filters: readonly SQL[],
  aggregate: SQL,
): Promise<Array<{ businessId: string; businessName: string; color: string; cents: number }>> {
  const rows = await db.select({
    businessId: businesses.key,
    businessName: businesses.name,
    color: businesses.color,
    cents: sql<number>`coalesce(${aggregate}, 0)::int`,
  }).from(transactions)
    .innerJoin(businesses, eq(transactions.businessId, businesses.id))
    .leftJoin(accounts, eq(transactions.accountId, accounts.id))
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(and(gte(transactions.date, from), lte(transactions.date, to), ...filters))
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
}

function averageCents(values: number[]): number {
  return Math.round(values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1));
}

async function cashFlowTotals(
  from: string,
  to: string,
  businessId: string | null,
  accountIds: string[],
  includeTransfers: boolean,
) {
  // Operating cash flow: inflow includes revenue but excludes transfers; outflow excludes
  // transfers and income. The includeTransfers toggle widens both to all movement.
  const inflowFilter = includeTransfers ? sql`true` : sql`NOT (${transferCategoryFilter()})`;
  const spendFilter = includeTransfers ? sql`true` : categoryIsVisibleSpend();
  const [row] = await db.select({
    inflowCents: sql<number>`coalesce(sum(CASE WHEN ${transactions.amountCents} > 0 AND ${inflowFilter} THEN ${transactions.amountCents} ELSE 0 END), 0)::int`,
    outflowCents: sql<number>`coalesce(abs(sum(CASE WHEN ${transactions.amountCents} < 0 AND ${spendFilter} THEN ${transactions.amountCents} ELSE 0 END)), 0)::int`,
    transferCents: sql<number>`coalesce(sum(CASE WHEN ${transferCategoryFilter()} THEN abs(${transactions.amountCents}) ELSE 0 END), 0)::int`,
  })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(and(
      gte(transactions.date, from),
      lte(transactions.date, to),
      businessId ? eq(transactions.businessId, businessId) : sql`true`,
      accountSpendFilter(accountIds),
    ));
  const inflowCents = Number(row?.inflowCents ?? 0);
  const outflowCents = Number(row?.outflowCents ?? 0);
  return {
    inflowCents,
    outflowCents,
    transferCents: Number(row?.transferCents ?? 0),
    netCents: inflowCents - outflowCents,
  };
}

async function cashFlowBusinessBreakdown(
  from: string,
  to: string,
  businessId: string | null,
  accountIds: string[],
  includeTransfers: boolean,
) {
  const inflowFilter = includeTransfers ? sql`true` : sql`NOT (${transferCategoryFilter()})`;
  const spendFilter = includeTransfers ? sql`true` : categoryIsVisibleSpend();
  const rows = await db.select({
    businessId: businesses.key,
    businessName: businesses.name,
    color: businesses.color,
    inflowCents: sql<number>`coalesce(sum(CASE WHEN ${transactions.amountCents} > 0 AND ${inflowFilter} THEN ${transactions.amountCents} ELSE 0 END), 0)::int`,
    outflowCents: sql<number>`coalesce(abs(sum(CASE WHEN ${transactions.amountCents} < 0 AND ${spendFilter} THEN ${transactions.amountCents} ELSE 0 END)), 0)::int`,
    transferCents: sql<number>`coalesce(sum(CASE WHEN ${transferCategoryFilter()} THEN abs(${transactions.amountCents}) ELSE 0 END), 0)::int`,
  })
    .from(transactions)
    .innerJoin(businesses, eq(transactions.businessId, businesses.id))
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(and(
      gte(transactions.date, from),
      lte(transactions.date, to),
      businessId ? eq(transactions.businessId, businessId) : sql`true`,
      accountSpendFilter(accountIds),
    ))
    .groupBy(businesses.key, businesses.name, businesses.color)
    .orderBy(desc(sql`abs(sum(${transactions.amountCents}))`));
  return rows.map((row) => {
    const inflowCents = Number(row.inflowCents ?? 0);
    const outflowCents = Number(row.outflowCents ?? 0);
    return {
      businessId: row.businessId,
      businessName: row.businessName,
      color: row.color,
      inflowCents,
      outflowCents,
      transferCents: Number(row.transferCents ?? 0),
      netCents: inflowCents - outflowCents,
    };
  });
}

function sumCashFlowPeriods(rows: Array<{
  inflowCents: number;
  outflowCents: number;
  transferCents: number;
  netCents: number;
  previousInflowCents: number;
  previousOutflowCents: number;
  previousTransferCents: number;
  previousNetCents: number;
}>) {
  const totals = rows.reduce((sum, row) => ({
    inflowCents: sum.inflowCents + row.inflowCents,
    outflowCents: sum.outflowCents + row.outflowCents,
    transferCents: sum.transferCents + row.transferCents,
    netCents: sum.netCents + row.netCents,
    previousInflowCents: sum.previousInflowCents + row.previousInflowCents,
    previousOutflowCents: sum.previousOutflowCents + row.previousOutflowCents,
    previousTransferCents: sum.previousTransferCents + row.previousTransferCents,
    previousNetCents: sum.previousNetCents + row.previousNetCents,
  }), {
    inflowCents: 0,
    outflowCents: 0,
    transferCents: 0,
    netCents: 0,
    previousInflowCents: 0,
    previousOutflowCents: 0,
    previousTransferCents: 0,
    previousNetCents: 0,
  });
  const netDeltaCents = totals.netCents - totals.previousNetCents;
  return {
    ...totals,
    netDeltaCents,
    netDeltaPct: totals.previousNetCents !== 0 ? Math.round((netDeltaCents / Math.abs(totals.previousNetCents)) * 100) : 0,
  };
}

function cashFlowPeriods(from: string, to: string, group: 'month' | 'year') {
  const start = dateFromIso(from);
  const end = dateFromIso(to);
  const periods: Array<{ label: string; from: string; to: string }> = [];
  const cursor = group === 'year'
    ? new Date(start.getFullYear(), 0, 1)
    : new Date(start.getFullYear(), start.getMonth(), 1);
  while (cursor <= end) {
    const periodStart = group === 'year'
      ? new Date(cursor.getFullYear(), 0, 1)
      : new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const periodEnd = group === 'year'
      ? new Date(cursor.getFullYear(), 11, 31)
      : new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    periods.push({
      label: group === 'year'
        ? String(cursor.getFullYear())
        : cursor.toLocaleString('en-US', { month: 'short', year: '2-digit' }),
      from: isoDate(periodStart < start ? start : periodStart),
      to: isoDate(periodEnd > end ? end : periodEnd),
    });
    if (group === 'year') cursor.setFullYear(cursor.getFullYear() + 1);
    else cursor.setMonth(cursor.getMonth() + 1);
  }
  return periods;
}

function shiftIsoYear(value: string, delta: number): string {
  const date = dateFromIso(value);
  date.setFullYear(date.getFullYear() + delta);
  return isoDate(date);
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

export type FlowBucketPreset = 'month' | 'last3' | 'last12' | 'ytd';
export type FlowBucketGranularity = 'day' | 'week' | 'month';

export function flowBucketWindows(from: string, to: string, preset?: FlowBucketPreset): {
  granularity: FlowBucketGranularity;
  windows: Array<{ from: string; to: string; label: string }>;
} {
  const granularity = preset === 'last3'
    ? 'week'
    : preset === 'last12' || preset === 'ytd'
      ? 'month'
      : preset === 'month'
        ? 'day'
        : inferBucketGranularity(from, to);
  if (granularity === 'day') return { granularity, windows: dailyWindows(from, to) };
  if (granularity === 'week') return { granularity, windows: weeklyWindows(from, to) };
  return { granularity, windows: monthlyWindows(from, to) };
}

function inferBucketGranularity(from: string, to: string): FlowBucketGranularity {
  const days = Math.max(1, Math.round((dateFromIso(to).getTime() - dateFromIso(from).getTime()) / 86400000) + 1);
  if (days <= 45) return 'day';
  if (days <= 120) return 'week';
  return 'month';
}

function dailyWindows(from: string, to: string) {
  const end = dateFromIso(to);
  const cursor = dateFromIso(from);
  const windows: Array<{ from: string; to: string; label: string }> = [];
  while (cursor <= end) {
    windows.push({
      from: isoDate(cursor),
      to: isoDate(cursor),
      label: cursor.toLocaleString('en-US', { month: 'short', day: 'numeric' }),
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return windows;
}

function weeklyWindows(from: string, to: string) {
  const end = dateFromIso(to);
  const cursor = dateFromIso(from);
  const windows: Array<{ from: string; to: string; label: string }> = [];
  while (cursor <= end) {
    const start = new Date(cursor);
    const weekEnd = new Date(cursor);
    weekEnd.setDate(weekEnd.getDate() + 6);
    const cappedEnd = weekEnd > end ? end : weekEnd;
    windows.push({
      from: isoDate(start),
      to: isoDate(cappedEnd),
      label: `${start.toLocaleString('en-US', { month: 'short', day: 'numeric' })}`,
    });
    cursor.setDate(cursor.getDate() + 7);
  }
  return windows;
}

function monthlyWindows(from: string, to: string) {
  const start = dateFromIso(from);
  const end = dateFromIso(to);
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  const windows: Array<{ from: string; to: string; label: string }> = [];
  while (cursor <= end) {
    const periodStart = new Date(cursor);
    const periodEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    windows.push({
      from: isoDate(periodStart < start ? start : periodStart),
      to: isoDate(periodEnd > end ? end : periodEnd),
      label: cursor.toLocaleString('en-US', { month: 'short', year: '2-digit' }),
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return windows;
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
  return sql`NOT (${transferCategoryFilter()})
    AND NOT (
      coalesce(${categories.taxCode}, '') = 'income'
      OR lower(coalesce(${categories.name}, '')) IN ('income', 'revenue')
    )`;
}

function transferCategoryFilter() {
  return sql`coalesce(${categories.taxCode}, '') LIKE 'exclude_%'
    OR lower(coalesce(${categories.name}, '')) = 'transfers'`;
}

function transactionDirectionFilter(direction: TransactionDirection) {
  switch (direction) {
    case 'inflow':
      return sql`${transactions.amountCents} > 0`;
    case 'outflow':
      return sql`${transactions.amountCents} < 0`;
    case 'operating-outflow':
      return sql`${transactions.amountCents} < 0 AND ${categoryIsVisibleSpend()}`;
    case 'transfer':
      return transferCategoryFilter();
    default:
      return sql`true`;
  }
}

function joinedTransactionSpendFilter(accountIds: string[]) {
  return sql`${transactions.id} IS NULL OR (${accountSpendFilter(accountIds)})`;
}

function transactionSortColumn(sort: 'date' | 'amount' | 'largest' | 'merchant' | 'business' | 'category' | 'account') {
  switch (sort) {
    case 'amount':
      return transactions.amountCents;
    case 'largest':
      return sql`abs(${transactions.amountCents})`;
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

type TransactionDirection = 'all' | 'inflow' | 'outflow' | 'operating-outflow' | 'transfer';

const receiptStatuses = ['matched', 'pending', 'missing', 'n/a', 'waived'] as const;
type ReceiptStatus = typeof receiptStatuses[number];

function isReceiptStatus(value: string): value is ReceiptStatus {
  return (receiptStatuses as readonly string[]).includes(value);
}
