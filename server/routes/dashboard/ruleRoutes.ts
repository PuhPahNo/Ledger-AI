import type { FastifyInstance } from 'fastify';
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireUser } from '../../auth/session.js';
import { db } from '../../db/client.js';
import { businesses, categories, categoryRules, transactions } from '../../db/schema.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { audit } from '../../services/audit.js';
import {
  categoryMatchesTransactionDirection,
  compareRulePrecedence,
  merchantPrefilterSql,
  ruleMatches,
  validateRuleCategory,
} from '../../services/categorization.js';
import { PROTECTED_CATEGORY_SOURCES, updateTransactionCategory } from '../../services/categorizationReviewActions.js';
import { plaidCategoryHints } from '../../services/receiptCategoryEvidence.js';
import { listLearnedRules, undoLearnedRule } from '../../services/categorizationLearning.js';
import { AUTOMATION_SETTING_LIMITS, getAutomationSettings, setAutomationSettings } from '../../services/appSettings.js';

/**
 * The rules engine was previously write-only: rules were learned from review prompts but
 * never visible, editable, or re-appliable. These routes back the Rules page.
 */
export function registerRuleRoutes(app: FastifyInstance): void {
  registerLearnedRuleRoutes(app);

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
    // Same precedence the engine uses, so the list reads top-to-bottom as "first match wins".
    rows.sort((a, b) => compareRulePrecedence(a.rule, b.rule) || a.categoryName.localeCompare(b.categoryName));

    const spend = await spendGroupsForStats();
    const amountRangeStats = await amountRangeHitStats(rows.map(({ rule }) => rule));
    return rows.map(({ rule, categoryName, businessKey, businessName }) => {
      const stats = amountRangeStats.get(rule.id) ?? ruleHitStats(rule, spend);
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
        userConfirmed: rule.userConfirmed,
        createdAt: rule.createdAt.toISOString(),
        updatedAt: rule.updatedAt.toISOString(),
        ...stats,
      };
    });
  });

  // Priority is ordering only; trust ('user_confirmed') is its own flag. Re-pointing a
  // rule at a new category is an explicit human decision, so it confirms the rule.
  app.patch('/categorization/rules/:id', async (request) => {
    const user = await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({
      categoryId: z.string().uuid().optional(),
      priority: z.number().int().min(0).max(1000).optional(),
      userConfirmed: z.boolean().optional(),
    }).parse(request.body);

    const rule = await db.query.categoryRules.findFirst({ where: eq(categoryRules.id, params.id) });
    if (!rule) notFound('Rule not found');
    const categoryChanged = body.categoryId !== undefined && body.categoryId !== rule.categoryId;
    if (categoryChanged) await assertRuleCategoryValid(rule.businessId, body.categoryId!, rule.categoryId);

    const [updated] = await db
      .update(categoryRules)
      .set({
        ...body,
        ...(categoryChanged && body.userConfirmed === undefined ? { userConfirmed: true } : {}),
        updatedAt: new Date(),
      })
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

    const isMerchantRule = rule.matchKind === 'merchant_exact' || rule.matchKind === 'merchant_contains';
    const candidates = await db
      .select()
      .from(transactions)
      .where(and(
        rule.businessId ? eq(transactions.businessId, rule.businessId) : sql`true`,
        sql`${transactions.categoryId} IS DISTINCT FROM ${rule.categoryId}`,
        // Safe superset prefilter; ruleMatches() below is still the source of truth.
        isMerchantRule ? merchantPrefilterSql(transactions.merchant, rule.pattern) : sql`true`,
      ));

    let appliedCount = 0;
    let skippedProtected = 0;
    for (const transaction of candidates) {
      if (!ruleMatches({
        matchKind: rule.matchKind,
        pattern: rule.pattern,
        merchant: transaction.merchant,
        plaidCategory: plaidCategoryHints(transaction.raw).join(' '),
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

export function registerLearnedRuleRoutes(app: FastifyInstance): void {
  // Digest: rules the system learned on its own (or, with via=all, from review accepts).
  app.get('/categorization/learned-rules', async (request) => {
    await requireUser(request);
    const query = z.object({
      biz: z.string().optional(),
      days: z.coerce.number().int().min(1).max(365).optional(),
      includeUndone: z.enum(['true', 'false']).optional(),
      via: z.enum(['auto', 'all']).optional(),
    }).parse(request.query);
    return listLearnedRules({
      businessKey: query.biz,
      days: query.days ?? 14,
      includeUndone: query.includeUndone === 'true',
      via: query.via ?? 'auto',
    });
  });

  // Undo: delete (or restore) the rule and put back exactly what it relabelled, skipping
  // any transaction someone has changed since.
  app.post('/categorization/learned-rules/:id/undo', async (request) => {
    const user = await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await undoLearnedRule({ id: params.id, userId: user.id });
    if (!result) notFound('Learned rule not found');
    if (!result.alreadyUndone) {
      await audit(request, user, 'undo_learned_category_rule', 'categorization_learned_rule', params.id, {
        ruleAction: result.ruleAction,
        restoredCount: result.restoredCount,
        skippedCount: result.skippedCount,
      });
    }
    return {
      id: result.learnedRule.id,
      alreadyUndone: result.alreadyUndone,
      ruleAction: result.ruleAction,
      restoredCount: result.restoredCount,
      skippedCount: result.skippedCount,
      undoneAt: result.learnedRule.undoneAt?.toISOString() ?? null,
    };
  });

  app.get('/categorization/automation-settings', async (request) => {
    await requireUser(request);
    return { ...(await getAutomationSettings()), limits: AUTOMATION_SETTING_LIMITS };
  });

  app.patch('/categorization/automation-settings', async (request) => {
    const user = await requireUser(request);
    const limits = AUTOMATION_SETTING_LIMITS;
    const body = z.object({
      autoLearnMinCorrections: z.number().int()
        .min(limits.autoLearnMinCorrections.min).max(limits.autoLearnMinCorrections.max).optional(),
      externalSignalAutoApplyConfidence: z.number()
        .min(limits.externalSignalAutoApplyConfidence.min).max(limits.externalSignalAutoApplyConfidence.max).optional(),
    }).parse(request.body ?? {});
    const settings = await setAutomationSettings(body);
    await audit(request, user, 'update_automation_settings', 'app_settings', undefined, body);
    return { ...settings, limits };
  });
}

/** Rejects (400) a category the rule can't use: wrong business, archived, or wrong direction. */
export async function assertRuleCategoryValid(
  ruleBusinessId: string | null,
  categoryId: string,
  previousCategoryId?: string | null,
): Promise<void> {
  const [category, previousCategory] = await Promise.all([
    db.query.categories.findFirst({ where: eq(categories.id, categoryId) }),
    previousCategoryId ? db.query.categories.findFirst({ where: eq(categories.id, previousCategoryId) }) : null,
  ]);
  if (!category) notFound('Category not found');
  const error = validateRuleCategory({ ruleBusinessId, category, previousCategory });
  if (error) badRequest(error);
}

interface SpendGroup {
  businessId: string;
  merchant: string;
  categoryId: string | null;
  plaidHints: string;
  count: number;
}

/**
 * Outflows grouped by (business, merchant, category, Plaid hints) — the only inputs the
 * merchant and plaid_category matchers read — so the rules list scans distinct merchants
 * instead of shipping every spend row to JS. Amount-range rules are counted in SQL.
 */
async function spendGroupsForStats(): Promise<SpendGroup[]> {
  const plaidHints = sql<string>`concat_ws(' ',
    (SELECT string_agg(value, ' ') FROM jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(${transactions.raw}->'category') = 'array' THEN ${transactions.raw}->'category' ELSE '[]'::jsonb END
    )),
    ${transactions.raw}->'personal_finance_category'->>'primary',
    ${transactions.raw}->'personal_finance_category'->>'detailed',
    ${transactions.raw}->'personal_finance_category'->>'confidence_level'
  )`;
  const rows = await db
    .select({
      businessId: transactions.businessId,
      merchant: transactions.merchant,
      categoryId: transactions.categoryId,
      plaidHints,
      count: sql<number>`count(*)::int`,
    })
    .from(transactions)
    .where(sql`${transactions.amountCents} < 0`)
    .groupBy(transactions.businessId, transactions.merchant, transactions.categoryId, plaidHints);
  return rows.map((row) => ({ ...row, plaidHints: row.plaidHints ?? '', count: Number(row.count) }));
}

type StatsRule = { id: string; businessId: string | null; categoryId: string; matchKind: string; pattern: string };
type HitStats = { matchCount: number | null; mismatchCount: number | null };

export function ruleHitStats(rule: StatsRule, spend: SpendGroup[]): HitStats {
  let matchCount = 0;
  let mismatchCount = 0;
  for (const row of spend) {
    if (rule.businessId && row.businessId !== rule.businessId) continue;
    if (!ruleMatches({
      matchKind: rule.matchKind,
      pattern: rule.pattern,
      merchant: row.merchant,
      plaidCategory: row.plaidHints,
      amountCents: -1,
    })) continue;
    matchCount += row.count;
    if (row.categoryId && row.categoryId !== rule.categoryId) mismatchCount += row.count;
  }
  return { matchCount, mismatchCount };
}

async function amountRangeHitStats(rules: StatsRule[]): Promise<Map<string, HitStats>> {
  const stats = new Map<string, HitStats>();
  for (const rule of rules) {
    if (rule.matchKind !== 'amount_range') continue;
    const [rawMin, rawMax] = rule.pattern.split('..');
    const min = rawMin ? Number(rawMin) : null;
    const max = rawMax ? Number(rawMax) : null;
    if ((min !== null && !Number.isFinite(min)) || (max !== null && !Number.isFinite(max))) {
      stats.set(rule.id, { matchCount: 0, mismatchCount: 0 });
      continue;
    }
    const [row] = await db
      .select({
        matchCount: sql<number>`count(*)::int`,
        mismatchCount: sql<number>`count(*) FILTER (WHERE ${transactions.categoryId} IS NOT NULL AND ${transactions.categoryId} <> ${rule.categoryId})::int`,
      })
      .from(transactions)
      .where(and(
        sql`${transactions.amountCents} < 0`,
        rule.businessId ? eq(transactions.businessId, rule.businessId) : sql`true`,
        min !== null ? sql`abs(${transactions.amountCents}) >= ${min}` : sql`true`,
        max !== null ? sql`abs(${transactions.amountCents}) <= ${max}` : sql`true`,
      ));
    stats.set(rule.id, { matchCount: Number(row?.matchCount ?? 0), mismatchCount: Number(row?.mismatchCount ?? 0) });
  }
  return stats;
}
