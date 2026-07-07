import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, getTableColumns, gte, ilike, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireUser } from '../../auth/session.js';
import { db } from '../../db/client.js';
import { accounts, businesses, categories, transactionTags, transactions } from '../../db/schema.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { audit } from '../../services/audit.js';
import { categoryMatchesTransactionDirection, isIncomeCategory } from '../../services/categorization.js';
import { createManualCategorizationFeedback } from '../../services/categorizationFeedback.js';
import { attachReceipt } from '../../services/matching.js';
import { getReceiptTrackingSince, setReceiptTrackingSince } from '../../services/appSettings.js';
import { tagsByTransactionId } from '../../services/tagging.js';
import { normalizeTransactionOverride } from '../../services/transactionOverrides.js';
import { toApiTransaction } from '../mappers.js';
import {
  accountSpendFilter,
  categoryIsVisibleSpend,
  isReceiptStatus,
  parseAccountIds,
  parseList,
  transferCategoryFilter,
  transactionDirectionFilter,
  transactionSortColumn,
} from './helpers.js';

export function registerTransactionRoutes(app: FastifyInstance): void {
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
      tags: z.string().optional(),
      direction: z.enum(['all', 'inflow', 'outflow', 'operating-outflow', 'transfer']).default('all'),
      offset: z.coerce.number().int().min(0).default(0),
      sort: z.enum(['date', 'amount', 'largest', 'merchant', 'business', 'category', 'account']).default('date'),
      dir: z.enum(['asc', 'desc']).default('desc'),
    }).parse(request.query);
    const accountIds = parseAccountIds(query.accounts);
    const categoryNames = parseList(query.categories);
    const receiptStatuses = parseList(query.receipts).filter(isReceiptStatus);
    const tagIds = parseList(query.tags);
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
        // ANY-of semantics: a transaction shows if it carries at least one selected tag.
        tagIds.length ? sql`EXISTS (
          SELECT 1 FROM ${transactionTags}
          WHERE ${transactionTags.transactionId} = ${transactions.id}
            AND ${inArray(transactionTags.tagId, tagIds)}
        )` : sql`true`,
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
    const tagsById = await tagsByTransactionId(rows.map((row) => row.id));
    return rows.map((row) => toApiTransaction({ ...row, tags: tagsById.get(row.id) ?? [] }));
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
      tags: z.string().optional(),
      direction: z.enum(['all', 'inflow', 'outflow', 'operating-outflow', 'transfer']).default('all'),
    }).parse(request.query);
    const accountIds = parseAccountIds(query.accounts);
    const categoryNames = parseList(query.categories);
    const receiptStatuses = parseList(query.receipts).filter(isReceiptStatus);
    const tagIds = parseList(query.tags);
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
        // ANY-of semantics, mirroring the /transactions list filter so the metric
        // tiles always agree with the tag-filtered table.
        tagIds.length ? sql`EXISTS (
          SELECT 1 FROM ${transactionTags}
          WHERE ${transactionTags.transactionId} = ${transactions.id}
            AND ${inArray(transactionTags.tagId, tagIds)}
        )` : sql`true`,
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
    // Direction guard: spend can't be filed under Income and vice versa (transfers excepted).
    if (selectedCategory && !categoryMatchesTransactionDirection(selectedCategory, previous.amountCents)) {
      badRequest(previous.amountCents < 0
        ? `"${selectedCategory.name}" is an income category — this is an outflow.`
        : `"${selectedCategory.name}" is a spend category — this is an inflow.`);
    }

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

  // Bulk manual categorization — the drawer's one-at-a-time flow made cleaning up a
  // merchant's history painful. Learning feedback fires once per distinct merchant.
  app.post('/transactions/bulk-category', async (request) => {
    const user = await requireUser(request);
    const body = z.object({
      transactionIds: z.array(z.string().uuid()).min(1).max(200),
      categoryId: z.string().uuid(),
    }).parse(request.body);

    const selectedCategory = await db.query.categories.findFirst({ where: eq(categories.id, body.categoryId) });
    if (!selectedCategory) notFound('Category not found');

    const rows = await db.select().from(transactions).where(inArray(transactions.id, body.transactionIds));
    const seenMerchants = new Set<string>();
    let updated = 0;
    let skipped = 0;
    for (const transaction of rows) {
      // Direction guard: don't file spend under Income (or vice versa) in bulk.
      if (!categoryMatchesTransactionDirection(selectedCategory, transaction.amountCents)) {
        skipped += 1;
        continue;
      }
      if (transaction.categoryId === body.categoryId) {
        skipped += 1;
        continue;
      }
      const previousCategoryId = transaction.categoryId;
      await db
        .update(transactions)
        .set({
          categoryId: body.categoryId,
          categorySource: 'manual',
          categoryConfidence: '1.0000',
          categoryEvidence: { source: 'bulk_categorize' },
          updatedAt: new Date(),
        })
        .where(eq(transactions.id, transaction.id));
      updated += 1;

      const merchantKey = `${transaction.businessId}:${transaction.merchant.toLowerCase()}`;
      if (
        transaction.amountCents < 0
        && !isIncomeCategory(selectedCategory)
        && !seenMerchants.has(merchantKey)
      ) {
        seenMerchants.add(merchantKey);
        await createManualCategorizationFeedback({
          transaction: { ...transaction, categoryId: body.categoryId },
          previousCategoryId,
          newCategoryId: body.categoryId,
          userId: user.id,
        });
      }
    }

    await audit(request, user, 'bulk_categorize_transactions', 'transaction', undefined, {
      categoryId: body.categoryId,
      requested: body.transactionIds.length,
      updated,
      skipped,
    });
    return { updated, skipped };
  });

  app.post('/transactions/:id/receipt', async (request) => {
    const user = await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ receiptId: z.string().uuid() }).parse(request.body);
    const updated = await attachReceipt(params.id, body.receiptId);
    if (!updated) notFound('Transaction not found');
    await audit(request, user, 'attach_receipt', 'transaction', params.id, { receiptId: body.receiptId });
    const row = await transactionById(params.id);
    if (!row) notFound('Transaction not found');
    return toApiTransaction(row as any);
  });

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
  if (!row) return row;
  const tagsById = await tagsByTransactionId([row.id]);
  return { ...row, tags: tagsById.get(row.id) ?? [] };
}
