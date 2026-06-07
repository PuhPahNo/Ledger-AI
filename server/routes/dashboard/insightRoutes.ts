import type { FastifyInstance } from 'fastify';
import { and, desc, eq, getTableColumns, gte, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireUser } from '../../auth/session.js';
import { db } from '../../db/client.js';
import { accounts, businesses, categories, transactions } from '../../db/schema.js';
import { toApiTransaction } from '../mappers.js';
import {
  accountSpendFilter,
  categoryIsVisibleSpend,
  comparisonWindow,
  comparisonWindowForRange,
  dateFromIso,
  isoDate,
  normalizeInsightMetric,
  parseAccountIds,
  transferCategoryFilter,
} from './helpers.js';

export function registerInsightRoutes(app: FastifyInstance): void {
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
        .where(and(...baseFilters, sql`${transactions.amountCents} > 0`, sql`NOT (${transferCategoryFilter()})`))
        .groupBy(businesses.key, businesses.name, businesses.color)
        .orderBy(desc(sql`sum(${transactions.amountCents})`)),
      db
        .select({
          transactionCount: sql<number>`count(${transactions.id})::int`,
          inflowCents: sql<number>`coalesce(sum(CASE WHEN ${transactions.amountCents} > 0 AND NOT (${transferCategoryFilter()}) THEN ${transactions.amountCents} ELSE 0 END), 0)::int`,
          outflowCents: sql<number>`coalesce(abs(sum(CASE WHEN ${transactions.amountCents} < 0 AND ${categoryIsVisibleSpend()} THEN ${transactions.amountCents} ELSE 0 END)), 0)::int`,
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
}
