import { and, desc, eq, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  businesses,
  categories,
  categorizationFeedback,
  categorizationLearnedRules,
  categorizationReviewItems,
  categorizationRuleRelabels,
  categoryRules,
  transactions,
  type Category,
  type CategoryRule,
  type CategorySource,
  type CategorizationLearnedRule,
  type CategorizationReviewItem,
  type CategorizationRuleRelabel,
  type LearnedRulePreviousState,
  type LearnedRuleVia,
} from '../db/schema.js';
import { getAutomationSettings } from './appSettings.js';
import {
  PROTECTED_CATEGORY_SOURCES,
  categoryMatchesTransactionDirection,
  invalidateAiCategorizationCache,
  isIncomeCategory,
  normalize,
} from './categorization.js';
import {
  matchingTransactions,
  recordCategoryEvent,
  updateTransactionCategory,
  upsertMerchantRule,
  upsertReviewItem,
} from './categorizationReviewActions.js';
import { applyTagRulesBestEffort } from './tagging.js';

/**
 * The learning loop.
 *
 * A single manual correction only teaches the AI (a feedback example). When the user sets
 * the same category for the same merchant on `autoLearnMinCorrections` distinct
 * transactions with no contradicting correction in between, the system learns a trusted
 * merchant rule on its own, relabels that merchant's machine-guessed history, and logs
 * exactly what it changed so the owner can undo it from the digest. A correction that
 * contradicts an existing trusted rule never flips it silently: it opens one
 * rule-conflict review item for that merchant.
 */

/** Feedback sources that are a human decision about a merchant's category. */
export const HUMAN_FEEDBACK_SOURCES: ReadonlySet<string> = new Set([
  'manual',
  'ai_suggestion_accepted',
  'external_suggestion_accepted',
  'review_group_accepted',
]);

/** Feedback rows from external systems are stored as `external:<source>` (e.g. external:quickbooks). */
export const EXTERNAL_FEEDBACK_PREFIX = 'external:';

/**
 * External signals only corroborate a human streak (never start one), and only when the
 * source was very sure — an accountant's QuickBooks mapping, not a fuzzy guess.
 */
export const EXTERNAL_LEARNING_MIN_CONFIDENCE = 0.95;

export const RULE_CONTRADICTION_KIND = 'learned_rule_contradiction';

// ---------------------------------------------------------------------------
// Consistency detector (pure)
// ---------------------------------------------------------------------------

export interface CorrectionRecord {
  id: string;
  categoryId: string;
  transactionIds: string[];
  createdAt: Date;
  human: boolean;
  confidence?: number | null;
}

export type ConsistencyVerdict =
  | { learn: true; categoryId: string; feedbackIds: string[]; transactionIds: string[] }
  | {
    learn: false;
    categoryId: string | null;
    feedbackIds: string[];
    transactionIds: string[];
    reason: 'no_human_correction' | 'not_enough_corrections';
  };

/**
 * Walk the merchant's corrections newest-first. The newest human correction sets the
 * candidate category; the streak continues until a human correction to a different
 * category (a contradiction). Highly-confident external signals that agree with the
 * candidate and post-date the contradiction add corroborating transactions.
 */
export function detectConsistentCorrections(
  records: CorrectionRecord[],
  options: { minCorrections: number; externalMinConfidence?: number },
): ConsistencyVerdict {
  const sorted = [...records].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const human = sorted.filter((record) => record.human);
  if (!human.length) {
    return { learn: false, categoryId: null, feedbackIds: [], transactionIds: [], reason: 'no_human_correction' };
  }
  const categoryId = human[0].categoryId;
  const feedbackIds: string[] = [];
  const transactionIds = new Set<string>();
  let contradictionAt: Date | null = null;
  for (const record of human) {
    if (record.categoryId !== categoryId) {
      contradictionAt = record.createdAt;
      break;
    }
    feedbackIds.push(record.id);
    for (const id of record.transactionIds) transactionIds.add(id);
  }

  const externalMin = options.externalMinConfidence ?? EXTERNAL_LEARNING_MIN_CONFIDENCE;
  for (const record of sorted) {
    if (record.human || record.categoryId !== categoryId) continue;
    if ((record.confidence ?? 0) < externalMin) continue;
    if (contradictionAt && record.createdAt <= contradictionAt) continue;
    feedbackIds.push(record.id);
    for (const id of record.transactionIds) transactionIds.add(id);
  }

  const ids = [...transactionIds];
  if (ids.length >= Math.max(1, options.minCorrections)) {
    return { learn: true, categoryId, feedbackIds, transactionIds: ids };
  }
  return { learn: false, categoryId, feedbackIds, transactionIds: ids, reason: 'not_enough_corrections' };
}

export function feedbackRowToCorrection(row: {
  id: string;
  newCategoryId: string;
  transactionId: string | null;
  source: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}): CorrectionRecord | null {
  const human = HUMAN_FEEDBACK_SOURCES.has(row.source);
  const external = row.source.startsWith(EXTERNAL_FEEDBACK_PREFIX);
  if (!human && !external) return null;
  const extraIds = Array.isArray(row.payload.transactionIds)
    ? row.payload.transactionIds.filter((id): id is string => typeof id === 'string')
    : [];
  const confidence = typeof row.payload.confidence === 'number' ? row.payload.confidence : null;
  return {
    id: row.id,
    categoryId: row.newCategoryId,
    transactionIds: [...new Set([...(row.transactionId ? [row.transactionId] : []), ...extraIds])],
    createdAt: row.createdAt,
    human,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Evaluation after a correction
// ---------------------------------------------------------------------------

export type LearningOutcome =
  | { outcome: 'learned'; learnedRuleId: string; ruleId: string; appliedCount: number }
  | { outcome: 'conflict'; reviewItemId: string }
  | { outcome: 'already_learned'; ruleId: string }
  | { outcome: 'feedback_only'; corrections: number; needed: number }
  | { outcome: 'skipped' };

/**
 * Called after every human correction (and corroborating external signal) for a spend
 * merchant. The feedback row for this correction must already be stored.
 */
export async function evaluateMerchantLearning(input: {
  businessId: string;
  merchant: string;
  categoryId: string;
  transactionIds: string[];
  userId?: string;
  /** False for external signals: they may complete a human streak but never open conflicts. */
  human: boolean;
}): Promise<LearningOutcome> {
  const normalizedMerchant = normalize(input.merchant);
  if (!isLearnableMerchant(normalizedMerchant)) return { outcome: 'skipped' };

  const rule = await merchantRule(input.businessId, normalizedMerchant);
  if (rule?.userConfirmed) {
    if (rule.categoryId === input.categoryId) {
      await expireOpenLearnPrompts(input.businessId, normalizedMerchant, rule.categoryId);
      return { outcome: 'already_learned', ruleId: rule.id };
    }
    if (!input.human) return { outcome: 'skipped' };
    const item = await openRuleContradiction({
      rule,
      businessId: input.businessId,
      merchant: input.merchant,
      normalizedMerchant,
      proposedCategoryId: input.categoryId,
      transactionIds: input.transactionIds,
    });
    return item ? { outcome: 'conflict', reviewItemId: item.id } : { outcome: 'skipped' };
  }

  const settings = await getAutomationSettings();
  const records = await correctionRecords(input.businessId, normalizedMerchant);
  const verdict = detectConsistentCorrections(records, { minCorrections: settings.autoLearnMinCorrections });
  if (!verdict.learn) {
    return {
      outcome: 'feedback_only',
      corrections: verdict.transactionIds.length,
      needed: settings.autoLearnMinCorrections,
    };
  }

  const learned = await learnMerchantRule({
    businessId: input.businessId,
    merchant: input.merchant,
    normalizedMerchant,
    categoryId: verdict.categoryId,
    learnedVia: 'consistent_corrections',
    feedbackIds: verdict.feedbackIds,
    sourceTransactionIds: verdict.transactionIds,
    userId: input.userId,
  });
  if (!learned) return { outcome: 'skipped' };
  return {
    outcome: 'learned',
    learnedRuleId: learned.learnedRule.id,
    ruleId: learned.rule.id,
    appliedCount: learned.appliedCount,
  };
}

export function isLearnableMerchant(normalizedMerchant: string): boolean {
  return Boolean(normalizedMerchant) && normalizedMerchant !== 'unknown merchant';
}

async function merchantRule(businessId: string, normalizedMerchant: string): Promise<CategoryRule | undefined> {
  return db.query.categoryRules.findFirst({
    where: and(
      eq(categoryRules.businessId, businessId),
      eq(categoryRules.matchKind, 'merchant_exact'),
      eq(categoryRules.pattern, normalizedMerchant),
    ),
  });
}

/** Human (and external) corrections for the merchant since its last undone learned rule. */
async function correctionRecords(businessId: string, normalizedMerchant: string): Promise<CorrectionRecord[]> {
  const [lastUndo] = await db
    .select({ undoneAt: categorizationLearnedRules.undoneAt })
    .from(categorizationLearnedRules)
    .where(and(
      eq(categorizationLearnedRules.businessId, businessId),
      eq(categorizationLearnedRules.normalizedMerchant, normalizedMerchant),
      isNotNull(categorizationLearnedRules.undoneAt),
    ))
    .orderBy(desc(categorizationLearnedRules.undoneAt))
    .limit(1);
  const rows = await db
    .select({
      id: categorizationFeedback.id,
      newCategoryId: categorizationFeedback.newCategoryId,
      transactionId: categorizationFeedback.transactionId,
      source: categorizationFeedback.source,
      payload: categorizationFeedback.payload,
      createdAt: categorizationFeedback.createdAt,
    })
    .from(categorizationFeedback)
    .where(and(
      eq(categorizationFeedback.businessId, businessId),
      eq(categorizationFeedback.normalizedMerchant, normalizedMerchant),
      // After an undo only fresh corrections count, so the rule doesn't relearn instantly.
      lastUndo?.undoneAt ? sql`${categorizationFeedback.createdAt} > ${lastUndo.undoneAt}` : sql`true`,
    ))
    .orderBy(desc(categorizationFeedback.createdAt))
    .limit(100);
  return rows.map(feedbackRowToCorrection).filter((record): record is CorrectionRecord => record !== null);
}

// ---------------------------------------------------------------------------
// Learning a rule + relabelling history (with an exact undo log)
// ---------------------------------------------------------------------------

export interface LearnResult {
  learnedRule: CategorizationLearnedRule;
  rule: CategoryRule;
  appliedCount: number;
  /** Matching transactions a human already set to another category (left alone). */
  protectedMismatchIds: string[];
}

/** A merchant rule may only point at an active spend category usable by this business. */
export function isLearnableRuleCategory(
  category: Pick<Category, 'businessId' | 'name' | 'taxCode' | 'active'> & { id: string },
  businessId: string,
): boolean {
  if (!category.active) return false;
  if (category.businessId && category.businessId !== businessId) return false;
  if (isIncomeCategory(category)) return false;
  return categoryMatchesTransactionDirection(category, -1);
}

export async function learnMerchantRule(input: {
  businessId: string;
  merchant: string;
  normalizedMerchant: string;
  categoryId: string;
  learnedVia: LearnedRuleVia;
  feedbackIds?: string[];
  sourceTransactionIds?: string[];
  userId?: string;
}): Promise<LearnResult | null> {
  if (!isLearnableMerchant(input.normalizedMerchant)) return null;
  const category = await db.query.categories.findFirst({ where: eq(categories.id, input.categoryId) });
  if (!category || !isLearnableRuleCategory(category, input.businessId)) return null;

  const existing = await merchantRule(input.businessId, input.normalizedMerchant);
  const previousRule: LearnedRulePreviousState | null = existing
    ? {
      categoryId: existing.categoryId,
      priority: existing.priority,
      userConfirmed: existing.userConfirmed,
      createdByAi: existing.createdByAi,
    }
    : null;
  const rule = await upsertMerchantRule({
    businessId: input.businessId,
    categoryId: input.categoryId,
    pattern: input.normalizedMerchant,
  });

  const [learnedRule] = await db
    .insert(categorizationLearnedRules)
    .values({
      businessId: input.businessId,
      ruleId: rule.id,
      merchant: input.merchant,
      normalizedMerchant: input.normalizedMerchant,
      categoryId: input.categoryId,
      learnedVia: input.learnedVia,
      previousRule,
      feedbackIds: input.feedbackIds ?? [],
      sourceTransactionIds: input.sourceTransactionIds ?? [],
      createdByUserId: input.userId,
    })
    .returning();

  const matches = await matchingTransactions(input.businessId, input.normalizedMerchant);
  const mismatched = matches.filter((match) => match.categoryId !== input.categoryId);
  const applyIds = mismatched
    .filter((match) => !PROTECTED_CATEGORY_SOURCES.has(match.categorySource))
    .map((match) => match.id);
  const protectedMismatchIds = mismatched
    .filter((match) => PROTECTED_CATEGORY_SOURCES.has(match.categorySource))
    .map((match) => match.id);

  let appliedCount = 0;
  if (applyIds.length) {
    const affected = await db.select().from(transactions).where(inArray(transactions.id, applyIds));
    for (const transaction of affected) {
      // Re-check: a human may have edited it between the match query and now.
      if (PROTECTED_CATEGORY_SOURCES.has(transaction.categorySource)) continue;
      await db.insert(categorizationRuleRelabels).values({
        learnedRuleId: learnedRule.id,
        transactionId: transaction.id,
        previousCategoryId: transaction.categoryId,
        previousCategorySource: transaction.categorySource,
        previousCategoryConfidence: transaction.categoryConfidence,
        previousCategoryEvidence: transaction.categoryEvidence ?? {},
        newCategoryId: input.categoryId,
      }).onConflictDoNothing();
      await updateTransactionCategory({
        transaction,
        newCategoryId: input.categoryId,
        source: 'user_confirmed_rule',
        confidence: 1,
        evidence: {
          ruleId: rule.id,
          rulePattern: input.normalizedMerchant,
          learningEventId: learnedRule.id,
          learnedVia: input.learnedVia,
        },
        userId: input.userId,
      });
      appliedCount += 1;
    }
  }
  // The rule now outranks the AI for this merchant; drop the stale cached verdict too.
  await invalidateAiCategorizationCache({ businessId: input.businessId, merchant: input.merchant, amountCents: -1 });

  const [updated] = await db
    .update(categorizationLearnedRules)
    .set({ appliedCount, skippedProtectedCount: protectedMismatchIds.length })
    .where(eq(categorizationLearnedRules.id, learnedRule.id))
    .returning();
  await expireOpenLearnPrompts(input.businessId, input.normalizedMerchant, input.categoryId);
  return { learnedRule: updated ?? learnedRule, rule, appliedCount, protectedMismatchIds };
}

/**
 * Accepting a (legacy) learn prompt: learn the rule through the same logged path, then
 * hold human-set conflicting history for explicit review as before.
 */
export async function acceptLearningRule(item: CategorizationReviewItem, userId?: string): Promise<{
  appliedCount: number;
  conflictCount: number;
}> {
  const payload = item.payload;
  if (!payload.proposedCategoryId || !payload.proposedRule?.pattern) {
    return { appliedCount: 0, conflictCount: 0 };
  }
  const learned = await learnMerchantRule({
    businessId: item.businessId,
    merchant: payload.merchant ?? payload.proposedRule.pattern,
    normalizedMerchant: payload.proposedRule.pattern,
    categoryId: payload.proposedCategoryId,
    learnedVia: 'learn_prompt_accepted',
    sourceTransactionIds: payload.transactionIds ?? (payload.transactionId ? [payload.transactionId] : []),
    userId,
  });
  if (!learned) return { appliedCount: 0, conflictCount: 0 };

  const conflictIds = await nonUncategorized(learned.protectedMismatchIds);
  if (conflictIds.length) {
    const category = await db.query.categories.findFirst({ where: eq(categories.id, payload.proposedCategoryId) });
    await upsertReviewItem({
      businessId: item.businessId,
      type: 'rule_conflict_review',
      fingerprint: `conflict:${payload.proposedRule.pattern}:${payload.proposedCategoryId}:${[...conflictIds].sort().join(',')}`,
      title: `Review ${conflictIds.length} existing ${payload.merchant ?? 'merchant'} transaction${conflictIds.length === 1 ? '' : 's'}`,
      detail: `A new rule points to ${category?.name ?? 'the selected category'}, but these transactions already have categories.`,
      payload: {
        transactionIds: conflictIds,
        merchant: payload.merchant,
        normalizedMerchant: payload.proposedRule.pattern,
        proposedCategoryId: payload.proposedCategoryId,
        proposedCategoryName: category?.name ?? payload.proposedCategoryName,
        confidence: 1,
        evidence: { sourceReviewItemId: item.id },
      },
    });
  }
  return { appliedCount: learned.appliedCount, conflictCount: conflictIds.length };
}

async function nonUncategorized(ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await db
    .select({ id: transactions.id, categoryName: categories.name })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(inArray(transactions.id, ids));
  return rows.filter((row) => row.categoryName && row.categoryName !== 'Uncategorized').map((row) => row.id);
}

/**
 * Open learn prompts for a merchant are answered once a trusted rule exists: expire them
 * (they were never explicitly accepted, so they don't count as human approvals).
 */
export async function expireOpenLearnPrompts(
  businessId: string,
  normalizedMerchant: string,
  ruleCategoryId: string,
): Promise<number> {
  const rows = await db
    .update(categorizationReviewItems)
    .set({
      status: 'expired',
      resolvedAction: sql`CASE
        WHEN ${categorizationReviewItems.payload}->>'proposedCategoryId' = ${ruleCategoryId} THEN 'auto_learned'
        ELSE 'superseded_by_rule'
      END`,
      resolvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(
      eq(categorizationReviewItems.businessId, businessId),
      eq(categorizationReviewItems.type, 'learn_rule_prompt'),
      eq(categorizationReviewItems.status, 'open'),
      sql`coalesce(${categorizationReviewItems.payload}->>'normalizedMerchant', ${categorizationReviewItems.payload}->'proposedRule'->>'pattern') = ${normalizedMerchant}`,
    ))
    .returning({ id: categorizationReviewItems.id });
  return rows.length;
}

// ---------------------------------------------------------------------------
// Contradicting a trusted rule → one conflict item per merchant
// ---------------------------------------------------------------------------

export function ruleContradictionFingerprint(normalizedMerchant: string): string {
  return `rule-contradiction:${normalizedMerchant}`;
}

async function openRuleContradiction(input: {
  rule: CategoryRule;
  businessId: string;
  merchant: string;
  normalizedMerchant: string;
  proposedCategoryId: string;
  transactionIds: string[];
}): Promise<CategorizationReviewItem | null> {
  const fingerprint = ruleContradictionFingerprint(input.normalizedMerchant);
  // The owner already said "keep the rule" for this exact switch since the rule last changed.
  const [dismissed] = await db
    .select({ id: categorizationReviewItems.id })
    .from(categorizationReviewItems)
    .where(and(
      eq(categorizationReviewItems.businessId, input.businessId),
      eq(categorizationReviewItems.type, 'rule_conflict_review'),
      eq(categorizationReviewItems.status, 'dismissed'),
      eq(categorizationReviewItems.fingerprint, fingerprint),
      sql`${categorizationReviewItems.payload}->>'proposedCategoryId' = ${input.proposedCategoryId}`,
      gte(categorizationReviewItems.resolvedAt, input.rule.updatedAt),
    ))
    .limit(1);
  if (dismissed) return null;

  const [ruleCategory, proposedCategory, existing] = await Promise.all([
    db.query.categories.findFirst({ where: eq(categories.id, input.rule.categoryId) }),
    db.query.categories.findFirst({ where: eq(categories.id, input.proposedCategoryId) }),
    db.query.categorizationReviewItems.findFirst({
      where: and(
        eq(categorizationReviewItems.businessId, input.businessId),
        eq(categorizationReviewItems.type, 'rule_conflict_review'),
        eq(categorizationReviewItems.status, 'open'),
        eq(categorizationReviewItems.fingerprint, fingerprint),
      ),
    }),
  ]);
  if (!proposedCategory) return null;
  const sameProposal = existing?.payload.proposedCategoryId === input.proposedCategoryId;
  const transactionIds = [...new Set([
    ...(sameProposal ? existing?.payload.transactionIds ?? [] : []),
    ...input.transactionIds,
  ])];
  return upsertReviewItem({
    businessId: input.businessId,
    type: 'rule_conflict_review',
    fingerprint,
    title: `Update the ${input.merchant} rule?`,
    detail: `Your rule files ${input.merchant} under ${ruleCategory?.name ?? 'another category'}, but you set ${proposedCategory.name}. Accept to switch the rule; dismiss to keep it.`,
    payload: {
      transactionIds,
      transactionId: transactionIds[0],
      merchant: input.merchant,
      normalizedMerchant: input.normalizedMerchant,
      currentCategoryId: input.rule.categoryId,
      currentCategoryName: ruleCategory?.name ?? null,
      proposedCategoryId: input.proposedCategoryId,
      proposedCategoryName: proposedCategory.name,
      confidence: 1,
      evidence: { kind: RULE_CONTRADICTION_KIND, ruleId: input.rule.id },
    },
  });
}

export function isRuleContradictionItem(item: Pick<CategorizationReviewItem, 'type' | 'payload'>): boolean {
  return item.type === 'rule_conflict_review' && item.payload.evidence?.kind === RULE_CONTRADICTION_KIND;
}

/** Accepting a contradiction item switches the rule (logged, undoable) and relabels history. */
export async function acceptRuleContradiction(item: CategorizationReviewItem, userId?: string): Promise<number> {
  const normalizedMerchant = item.payload.normalizedMerchant;
  const categoryId = item.payload.proposedCategoryId;
  if (!normalizedMerchant || !categoryId) return 0;
  const learned = await learnMerchantRule({
    businessId: item.businessId,
    merchant: item.payload.merchant ?? normalizedMerchant,
    normalizedMerchant,
    categoryId,
    learnedVia: 'rule_conflict_accepted',
    sourceTransactionIds: item.payload.transactionIds ?? [],
    userId,
  });
  return learned?.appliedCount ?? 0;
}

// ---------------------------------------------------------------------------
// Undo (pure planning + DB apply)
// ---------------------------------------------------------------------------

export interface RelabelRestore {
  relabelId: string;
  transactionId: string;
  categoryId: string | null;
  categorySource: CategorySource;
  categoryConfidence: string | null;
  categoryEvidence: Record<string, unknown>;
}

export interface CurrentTransactionState {
  id: string;
  categoryId: string | null;
  categorySource: string;
  categoryEvidence: Record<string, unknown> | null;
}

/**
 * Restore only rows still exactly as this learned rule left them: same category, still
 * 'user_confirmed_rule', and still stamped with this event's id. Anything a human (or a
 * later rule) touched since is skipped.
 */
export function planLearnedRuleUndo(
  learnedRuleId: string,
  relabels: Array<Pick<CategorizationRuleRelabel,
    'id' | 'transactionId' | 'previousCategoryId' | 'previousCategorySource'
    | 'previousCategoryConfidence' | 'previousCategoryEvidence' | 'newCategoryId' | 'restoredAt'>>,
  current: Map<string, CurrentTransactionState>,
): { restore: RelabelRestore[]; skippedTransactionIds: string[] } {
  const restore: RelabelRestore[] = [];
  const skippedTransactionIds: string[] = [];
  for (const relabel of relabels) {
    if (relabel.restoredAt) continue;
    const transaction = current.get(relabel.transactionId);
    if (!transaction) continue;
    const untouched = transaction.categoryId === relabel.newCategoryId
      && transaction.categorySource === 'user_confirmed_rule'
      && transaction.categoryEvidence?.learningEventId === learnedRuleId;
    if (!untouched) {
      skippedTransactionIds.push(relabel.transactionId);
      continue;
    }
    restore.push({
      relabelId: relabel.id,
      transactionId: relabel.transactionId,
      categoryId: relabel.previousCategoryId,
      categorySource: relabel.previousCategorySource,
      categoryConfidence: relabel.previousCategoryConfidence,
      categoryEvidence: relabel.previousCategoryEvidence ?? {},
    });
  }
  return { restore, skippedTransactionIds };
}

export type RuleUndoAction = 'delete' | 'restore' | 'leave';

/** Put the rule back how it was — unless someone re-pointed it since (then leave it). */
export function planRuleUndo(
  learned: Pick<CategorizationLearnedRule, 'categoryId' | 'previousRule'>,
  currentRule: Pick<CategoryRule, 'categoryId'> | null | undefined,
): RuleUndoAction {
  if (!currentRule) return 'leave';
  if (currentRule.categoryId !== learned.categoryId) return 'leave';
  return learned.previousRule ? 'restore' : 'delete';
}

export interface UndoResult {
  learnedRule: CategorizationLearnedRule;
  alreadyUndone: boolean;
  ruleAction: RuleUndoAction;
  restoredCount: number;
  skippedCount: number;
}

export async function undoLearnedRule(input: { id: string; userId?: string }): Promise<UndoResult | null> {
  const learned = await db.query.categorizationLearnedRules.findFirst({
    where: eq(categorizationLearnedRules.id, input.id),
  });
  if (!learned) return null;
  if (learned.undoneAt) {
    return {
      learnedRule: learned,
      alreadyUndone: true,
      ruleAction: 'leave',
      restoredCount: learned.undoRestoredCount ?? 0,
      skippedCount: learned.undoSkippedCount ?? 0,
    };
  }

  // Claim the undo first so two concurrent clicks can't both restore.
  const [claimed] = await db
    .update(categorizationLearnedRules)
    .set({ undoneAt: new Date(), undoneByUserId: input.userId })
    .where(and(eq(categorizationLearnedRules.id, learned.id), isNull(categorizationLearnedRules.undoneAt)))
    .returning();
  if (!claimed) return undoLearnedRule(input);

  const currentRule = learned.ruleId
    ? await db.query.categoryRules.findFirst({ where: eq(categoryRules.id, learned.ruleId) })
    : null;
  const ruleAction = planRuleUndo(learned, currentRule);
  if (currentRule && ruleAction === 'delete') {
    await db.delete(categoryRules).where(eq(categoryRules.id, currentRule.id));
  } else if (currentRule && ruleAction === 'restore' && learned.previousRule) {
    await db.update(categoryRules).set({
      categoryId: learned.previousRule.categoryId,
      priority: learned.previousRule.priority,
      userConfirmed: learned.previousRule.userConfirmed,
      createdByAi: learned.previousRule.createdByAi,
      updatedAt: new Date(),
    }).where(eq(categoryRules.id, currentRule.id));
  }

  const relabels = await db
    .select()
    .from(categorizationRuleRelabels)
    .where(eq(categorizationRuleRelabels.learnedRuleId, learned.id));
  const current = relabels.length
    ? await db
      .select({
        id: transactions.id,
        categoryId: transactions.categoryId,
        categorySource: transactions.categorySource,
        categoryEvidence: transactions.categoryEvidence,
        businessId: transactions.businessId,
        merchant: transactions.merchant,
        amountCents: transactions.amountCents,
      })
      .from(transactions)
      .where(inArray(transactions.id, relabels.map((relabel) => relabel.transactionId)))
    : [];
  const currentById = new Map(current.map((row) => [row.id, row]));
  const plan = planLearnedRuleUndo(learned.id, relabels, currentById);

  let restoredCount = 0;
  for (const restore of plan.restore) {
    // Guarded write: only if the row is still exactly as the rule left it.
    const [saved] = await db
      .update(transactions)
      .set({
        categoryId: restore.categoryId,
        categorySource: restore.categorySource,
        categoryConfidence: restore.categoryConfidence,
        categoryEvidence: restore.categoryEvidence,
        updatedAt: new Date(),
      })
      .where(and(
        eq(transactions.id, restore.transactionId),
        eq(transactions.categorySource, 'user_confirmed_rule'),
        sql`${transactions.categoryEvidence}->>'learningEventId' = ${learned.id}`,
      ))
      .returning();
    if (!saved) continue;
    const before = currentById.get(restore.transactionId);
    await recordCategoryEvent({
      transaction: saved,
      previousCategoryId: before?.categoryId ?? null,
      newCategoryId: restore.categoryId,
      source: restore.categorySource,
      confidence: restore.categoryConfidence == null ? null : Number(restore.categoryConfidence),
      evidence: { undoOfLearningEventId: learned.id },
      userId: input.userId,
    });
    await db.update(categorizationRuleRelabels)
      .set({ restoredAt: new Date() })
      .where(eq(categorizationRuleRelabels.id, restore.relabelId));
    await applyTagRulesBestEffort(saved);
    restoredCount += 1;
  }
  const skippedCount = plan.skippedTransactionIds.length + (plan.restore.length - restoredCount);

  const [updated] = await db
    .update(categorizationLearnedRules)
    .set({ undoRestoredCount: restoredCount, undoSkippedCount: skippedCount })
    .where(eq(categorizationLearnedRules.id, learned.id))
    .returning();
  return {
    learnedRule: updated ?? claimed,
    alreadyUndone: false,
    ruleAction,
    restoredCount,
    skippedCount,
  };
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

export interface LearnedRuleDigestRow {
  id: string;
  businessId: string;
  biz: string | null;
  businessName: string | null;
  merchant: string;
  normalizedMerchant: string;
  categoryId: string;
  categoryName: string | null;
  previousCategoryId: string | null;
  previousCategoryName: string | null;
  learnedVia: LearnedRuleVia;
  ruleId: string | null;
  /** The rule still exists and still points at this category. */
  ruleActive: boolean;
  relabelledCount: number;
  /** Relabelled rows nobody has touched since — what undo would restore right now. */
  restorableCount: number;
  skippedProtectedCount: number;
  correctionCount: number;
  corrections: Array<{ transactionId: string; date: string; merchant: string; amountCents: number }>;
  learnedByUserId: string | null;
  learnedByName: string | null;
  createdAt: string;
  undoneAt: string | null;
  undoneByName: string | null;
  undoRestoredCount: number | null;
}

export async function listLearnedRules(input: {
  businessKey?: string;
  days?: number;
  includeUndone?: boolean;
  via?: 'auto' | 'all';
  now?: Date;
}): Promise<LearnedRuleDigestRow[]> {
  const days = input.days ?? 14;
  const since = new Date((input.now ?? new Date()).getTime() - days * 24 * 60 * 60 * 1000);
  const learnedBy = sql<string | null>`(SELECT display_name FROM users u WHERE u.id = ${categorizationLearnedRules.createdByUserId})`;
  const undoneBy = sql<string | null>`(SELECT display_name FROM users u WHERE u.id = ${categorizationLearnedRules.undoneByUserId})`;
  const previousCategoryName = sql<string | null>`(SELECT name FROM categories c WHERE c.id::text = ${categorizationLearnedRules.previousRule}->>'categoryId')`;
  const rows = await db
    .select({
      learned: categorizationLearnedRules,
      businessKey: businesses.key,
      businessName: businesses.name,
      categoryName: categories.name,
      learnedByName: learnedBy,
      undoneByName: undoneBy,
      previousCategoryName,
      ruleCategoryId: categoryRules.categoryId,
    })
    .from(categorizationLearnedRules)
    .innerJoin(businesses, eq(categorizationLearnedRules.businessId, businesses.id))
    .leftJoin(categories, eq(categorizationLearnedRules.categoryId, categories.id))
    .leftJoin(categoryRules, eq(categorizationLearnedRules.ruleId, categoryRules.id))
    .where(and(
      gte(categorizationLearnedRules.createdAt, since),
      input.businessKey && input.businessKey !== 'all' ? eq(businesses.key, input.businessKey) : sql`true`,
      input.includeUndone ? sql`true` : isNull(categorizationLearnedRules.undoneAt),
      input.via === 'all' ? sql`true` : eq(categorizationLearnedRules.learnedVia, 'consistent_corrections'),
    ))
    .orderBy(desc(categorizationLearnedRules.createdAt))
    .limit(200);
  if (!rows.length) return [];

  const ids = rows.map((row) => row.learned.id);
  const restorable = await db
    .select({
      learnedRuleId: categorizationRuleRelabels.learnedRuleId,
      count: sql<number>`count(*)::int`,
    })
    .from(categorizationRuleRelabels)
    .innerJoin(transactions, eq(categorizationRuleRelabels.transactionId, transactions.id))
    .where(and(
      inArray(categorizationRuleRelabels.learnedRuleId, ids),
      isNull(categorizationRuleRelabels.restoredAt),
      eq(transactions.categorySource, 'user_confirmed_rule'),
      sql`${transactions.categoryId} = ${categorizationRuleRelabels.newCategoryId}`,
      sql`${transactions.categoryEvidence}->>'learningEventId' = ${categorizationRuleRelabels.learnedRuleId}::text`,
    ))
    .groupBy(categorizationRuleRelabels.learnedRuleId);
  const restorableById = new Map(restorable.map((row) => [row.learnedRuleId, Number(row.count)]));

  const sourceIds = [...new Set(rows.flatMap((row) => row.learned.sourceTransactionIds.slice(0, 5)))];
  const sourceRows = sourceIds.length
    ? await db
      .select({ id: transactions.id, date: transactions.date, merchant: transactions.merchant, amountCents: transactions.amountCents })
      .from(transactions)
      .where(inArray(transactions.id, sourceIds))
    : [];
  const sourceById = new Map(sourceRows.map((row) => [row.id, row]));

  return rows.map((row) => {
    const learned = row.learned;
    return {
      id: learned.id,
      businessId: learned.businessId,
      biz: row.businessKey ?? null,
      businessName: row.businessName ?? null,
      merchant: learned.merchant,
      normalizedMerchant: learned.normalizedMerchant,
      categoryId: learned.categoryId,
      categoryName: row.categoryName ?? null,
      previousCategoryId: learned.previousRule?.categoryId ?? null,
      previousCategoryName: row.previousCategoryName ?? null,
      learnedVia: learned.learnedVia,
      ruleId: learned.ruleId,
      ruleActive: row.ruleCategoryId === learned.categoryId,
      relabelledCount: learned.appliedCount,
      restorableCount: learned.undoneAt ? 0 : restorableById.get(learned.id) ?? 0,
      skippedProtectedCount: learned.skippedProtectedCount,
      correctionCount: learned.sourceTransactionIds.length,
      corrections: learned.sourceTransactionIds.slice(0, 5)
        .map((id) => sourceById.get(id))
        .filter((txn): txn is NonNullable<typeof txn> => Boolean(txn))
        .map((txn) => ({ transactionId: txn.id, date: txn.date, merchant: txn.merchant, amountCents: txn.amountCents })),
      learnedByUserId: learned.createdByUserId,
      learnedByName: row.learnedByName ?? null,
      createdAt: learned.createdAt.toISOString(),
      undoneAt: learned.undoneAt?.toISOString() ?? null,
      undoneByName: row.undoneByName ?? null,
      undoRestoredCount: learned.undoRestoredCount,
    };
  });
}

// ---------------------------------------------------------------------------
// Nightly sweep over legacy learn prompts
// ---------------------------------------------------------------------------

/**
 * Open learn prompts predate auto-learning. Each night: expire the ones a trusted rule
 * already answers, and auto-learn the merchants whose stored corrections are consistent.
 * The rest stay open for the owner (single or grouped accept still works).
 */
export async function sweepOpenLearnPrompts(limit = 200): Promise<{ learned: number; expired: number }> {
  const items = await db
    .select()
    .from(categorizationReviewItems)
    .where(and(
      eq(categorizationReviewItems.type, 'learn_rule_prompt'),
      eq(categorizationReviewItems.status, 'open'),
    ))
    .orderBy(desc(categorizationReviewItems.createdAt))
    .limit(limit);
  const settings = await getAutomationSettings();
  const seen = new Set<string>();
  let learned = 0;
  let expired = 0;
  for (const item of items) {
    const normalizedMerchant = item.payload.normalizedMerchant ?? item.payload.proposedRule?.pattern;
    if (!normalizedMerchant || !isLearnableMerchant(normalizedMerchant)) continue;
    const key = `${item.businessId}:${normalizedMerchant}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const rule = await merchantRule(item.businessId, normalizedMerchant);
    if (rule?.userConfirmed) {
      expired += await expireOpenLearnPrompts(item.businessId, normalizedMerchant, rule.categoryId);
      continue;
    }
    const verdict = detectConsistentCorrections(
      await correctionRecords(item.businessId, normalizedMerchant),
      { minCorrections: settings.autoLearnMinCorrections },
    );
    if (!verdict.learn) continue;
    const result = await learnMerchantRule({
      businessId: item.businessId,
      merchant: item.payload.merchant ?? normalizedMerchant,
      normalizedMerchant,
      categoryId: verdict.categoryId,
      learnedVia: 'consistent_corrections',
      feedbackIds: verdict.feedbackIds,
      sourceTransactionIds: verdict.transactionIds,
    });
    if (result) learned += 1;
  }
  return { learned, expired };
}
