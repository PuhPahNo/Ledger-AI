import type { FastifyInstance } from 'fastify';
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireUser } from '../../auth/session.js';
import { db } from '../../db/client.js';
import { businesses, categories, categoryRules, transactions } from '../../db/schema.js';
import { notFound } from '../../lib/errors.js';
import { audit } from '../../services/audit.js';
import { categoryMatchesTransactionDirection, ruleMatches } from '../../services/categorization.js';
import { PROTECTED_CATEGORY_SOURCES, updateTransactionCategory } from '../../services/categorizationReviewActions.js';

/**
 * The rules engine was previously write-only: rules were learned from review prompts but
 * never visible, editable, or re-appliable. These routes back the Rules page.
 */
export function registerRuleRoutes(app: FastifyInstance): void {
  app.get('/categorization/rules', async (request) => {
    await requireUser(request);
    const query = z.object({ biz: z.string().optional() }).parse(request.query);
    const selectedBusiness = query.biz && query.biz !== 'all'
      ? await db.query.businesses.findFirst({ where: eq(businesses.key, query.biz) })
      : null;

    const rows = await db
      .select({
        rule: categoryRules,
        categoryName: categories.name,
        businessKey: businesses.key,
        businessName: businesses.name,
      })
      .from(categoryRules)
      .innerJoin(categories, eq(categoryRules.categoryId, categories.id))
      .leftJoin(businesses, eq(categoryRules.businessId, businesses.id))
      .where(selectedBusiness
        ? or(eq(categoryRules.businessId, selectedBusiness.id), isNull(categoryRules.businessId))
        : sql`true`)
      .orderBy(asc(categoryRules.priority), asc(categories.name));

    const spend = await spendTransactionsForStats();
    return rows.map(({ rule, categoryName, businessKey, businessName }) => {
      const stats = ruleHitStats(rule, spend);
      return {
        id: rule.id,
        businessId: rule.businessId,
        biz: businessKey ?? null,
        businessName: businessName ?? null,
        categoryId: rule.categoryId,
        categoryName,
        matchKind: rule.matchKind,
        pattern: rule.pattern,
        priority: rule.priority,
        createdByAi: rule.createdByAi,
        createdAt: rule.createdAt.toISOString(),
        updatedAt: rule.updatedAt.toISOString(),
        ...stats,
      };
    });
  });

  app.patch('/categorization/rules/:id', async (request) => {
    const user = await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({
      categoryId: z.string().uuid().optional(),
      priority: z.number().int().min(0).max(1000).optional(),
    }).parse(request.body);
    const [updated] = await db
      .update(categoryRules)
      .set({ ...body, createdByAi: false, updatedAt: new Date() })
      .where(eq(categoryRules.id, params.id))
      .returning();
    if (!updated) notFound('Rule not found');
    await audit(request, user, 'update_category_rule', 'category_rule', params.id, body);
    return { ok: true };
  });

  app.delete('/categorization/rules/:id', async (request, reply) => {
    const user = await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const [deleted] = await db.delete(categoryRules).where(eq(categoryRules.id, params.id)).returning();
    if (!deleted) notFound('Rule not found');
    await audit(request, user, 'delete_category_rule', 'category_rule', params.id, {
      pattern: deleted.pattern,
      matchKind: deleted.matchKind,
    });
    return reply.status(204).send();
  });

  // Re-categorize history with this rule. Machine-guessed categories are overwritten;
  // human-set ones are skipped unless includeProtected is passed explicitly.
  app.post('/categorization/rules/:id/apply', async (request) => {
    const user = await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ includeProtected: z.boolean().optional().default(false) }).parse(request.body ?? {});

    const rule = await db.query.categoryRules.findFirst({ where: eq(categoryRules.id, params.id) });
    if (!rule) notFound('Rule not found');
    const category = await db.query.categories.findFirst({ where: eq(categories.id, rule.categoryId) });
    if (!category) notFound('Rule category not found');

    const candidates = await db
      .select()
      .from(transactions)
      .where(and(
        rule.businessId ? eq(transactions.businessId, rule.businessId) : sql`true`,
        sql`${transactions.categoryId} IS DISTINCT FROM ${rule.categoryId}`,
      ));

    let appliedCount = 0;
    let skippedProtected = 0;
    for (const transaction of candidates) {
      if (!ruleMatches({
        matchKind: rule.matchKind,
        pattern: rule.pattern,
        merchant: transaction.merchant,
        amountCents: transaction.amountCents,
      })) continue;
      if (!categoryMatchesTransactionDirection(category, transaction.amountCents)) continue;
      if (!body.includeProtected && PROTECTED_CATEGORY_SOURCES.has(transaction.categorySource)) {
        skippedProtected += 1;
        continue;
      }
      await updateTransactionCategory({
        transaction,
        newCategoryId: rule.categoryId,
        source: 'user_confirmed_rule',
        confidence: 1,
        evidence: { ruleId: rule.id, appliedFromRulesPage: true },
        userId: user.id,
      });
      appliedCount += 1;
    }

    await audit(request, user, 'apply_category_rule', 'category_rule', params.id, {
      appliedCount,
      skippedProtected,
      includeProtected: body.includeProtected,
    });
    return { appliedCount, skippedProtected };
  });
}

interface SpendRow {
  businessId: string;
  merchant: string;
  amountCents: number;
  categoryId: string | null;
}

async function spendTransactionsForStats(): Promise<SpendRow[]> {
  return db
    .select({
      businessId: transactions.businessId,
      merchant: transactions.merchant,
      amountCents: transactions.amountCents,
      categoryId: transactions.categoryId,
    })
    .from(transactions)
    .where(sql`${transactions.amountCents} < 0`);
}

function ruleHitStats(
  rule: { businessId: string | null; categoryId: string; matchKind: string; pattern: string },
  spend: SpendRow[],
): { matchCount: number | null; mismatchCount: number | null } {
  // plaid_category rules match on Plaid hints we don't keep denormalized — no cheap count.
  if (rule.matchKind === 'plaid_category') return { matchCount: null, mismatchCount: null };
  let matchCount = 0;
  let mismatchCount = 0;
  for (const row of spend) {
    if (rule.businessId && row.businessId !== rule.businessId) continue;
    if (!ruleMatches({
      matchKind: rule.matchKind,
      pattern: rule.pattern,
      merchant: row.merchant,
      amountCents: row.amountCents,
    })) continue;
    matchCount += 1;
    if (row.categoryId && row.categoryId !== rule.categoryId) mismatchCount += 1;
  }
  return { matchCount, mismatchCount };
}
