import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  categories,
  businesses,
  categorizationFeedback,
  categorizationReviewItems,
  receipts,
  transactions,
  type CategorizationReviewItem,
  type Transaction,
} from '../db/schema.js';
import {
  categoryMatchesTransactionDirection,
  categorizeTransactionWithDetails,
  normalize,
  shouldAutoApplyAiSuggestion,
} from './categorization.js';
import {
  applyReviewItemCategory,
  updateTransactionCategory,
  upsertReviewItem,
} from './categorizationReviewActions.js';
import {
  acceptLearningRule,
  acceptRuleContradiction,
  evaluateMerchantLearning,
  isLearnableMerchant,
  isRuleContradictionItem,
  type LearningOutcome,
} from './categorizationLearning.js';
import {
  inferReceiptCategory,
  latestReceiptMatchScore,
  parseConfidence,
  plaidCategoryHints,
  receiptEvidenceCanAutoApply,
} from './receiptCategoryEvidence.js';
export { canAutoOverwriteCategorySource, receiptEvidenceCanAutoApply } from './receiptCategoryEvidence.js';

export type ReviewResolutionAction = 'accept' | 'dismiss';

export interface CategorizationReviewSummary {
  item: CategorizationReviewItem;
  appliedCount: number;
  conflictCount: number;
}

/**
 * Learning side of a manual outflow correction. Stores the feedback example the AI prompt
 * uses, then lets the learning loop decide: a single correction only teaches the AI;
 * consistent corrections auto-learn a trusted merchant rule; a correction contradicting a
 * trusted rule opens one conflict item. No per-edit "learn this merchant?" prompt anymore.
 * The caller records the category event (one per changed transaction) itself.
 *
 * `transactionIds` lets a bulk edit count every same-merchant row it changed as a
 * correction while writing a single feedback example (so one bulk edit doesn't flood
 * the AI prompt's example window).
 */
export async function createManualCategorizationFeedback(input: {
  transaction: Transaction;
  transactionIds?: string[];
  previousCategoryId: string | null;
  newCategoryId: string;
  userId?: string;
}): Promise<LearningOutcome | null> {
  if (input.transaction.amountCents >= 0) return null;
  const category = await db.query.categories.findFirst({ where: eq(categories.id, input.newCategoryId) });
  if (!category || categoryMatchesTransactionDirection(category, input.transaction.amountCents) === false) return null;

  const normalizedMerchant = normalize(input.transaction.merchant);
  if (!isLearnableMerchant(normalizedMerchant)) return null;

  const transactionIds = [...new Set([input.transaction.id, ...(input.transactionIds ?? [])])];
  await db.insert(categorizationFeedback).values({
    businessId: input.transaction.businessId,
    transactionId: input.transaction.id,
    merchant: input.transaction.merchant,
    normalizedMerchant,
    previousCategoryId: input.previousCategoryId,
    newCategoryId: input.newCategoryId,
    source: 'manual',
    payload: {
      reason: 'transaction_category_edit',
      ...(transactionIds.length > 1 ? { transactionIds } : {}),
    },
    createdByUserId: input.userId,
  });

  return evaluateMerchantLearning({
    businessId: input.transaction.businessId,
    merchant: input.transaction.merchant,
    categoryId: input.newCategoryId,
    transactionIds,
    userId: input.userId,
    human: true,
  });
}

export async function listCategorizationReviewItems(input: {
  businessKey?: string;
  status?: 'open' | 'accepted' | 'dismissed' | 'expired';
} = {}): Promise<Array<CategorizationReviewItem & { businessKey?: string | null }>> {
  const rows = await db
    .select({
      item: categorizationReviewItems,
      businessKey: businesses.key,
    })
    .from(categorizationReviewItems)
    .innerJoin(businesses, eq(categorizationReviewItems.businessId, businesses.id))
    .where(and(
      eq(categorizationReviewItems.status, input.status ?? 'open'),
      input.businessKey && input.businessKey !== 'all' ? eq(businesses.key, input.businessKey) : sql`true`,
    ))
    .orderBy(desc(categorizationReviewItems.createdAt))
    .limit(100);

  return rows.map((row) => ({ ...row.item, businessKey: row.businessKey }));
}

export async function resolveCategorizationReviewItem(input: {
  id: string;
  action: ReviewResolutionAction;
  userId?: string;
  /** Group accepts learn the merchant rule once for the whole group instead of per item. */
  skipLearning?: boolean;
}): Promise<CategorizationReviewSummary | null> {
  const item = await db.query.categorizationReviewItems.findFirst({
    where: eq(categorizationReviewItems.id, input.id),
  });
  if (!item || item.status !== 'open') return item ? { item, appliedCount: 0, conflictCount: 0 } : null;

  let appliedCount = 0;
  let conflictCount = 0;
  if (input.action === 'accept') {
    if (item.type === 'learn_rule_prompt') {
      const result = await acceptLearningRule(item, input.userId);
      appliedCount = result.appliedCount;
      conflictCount = result.conflictCount;
    } else if (item.type === 'ai_category_suggestion') {
      // A human approved it: store it under the protected 'manual' source so Plaid updates
      // can't overwrite it; the evidence (and event log) keep the AI provenance.
      appliedCount = await applyReviewItemCategory(item, 'manual', input.userId, {
        confidence: 1,
        evidence: acceptedAiSuggestionEvidence(item.payload.confidence),
      });
      await recordAcceptedSuggestionFeedback(item, 'ai_suggestion_accepted', input.userId, !input.skipLearning);
    } else if (item.type === 'external_category_suggestion') {
      appliedCount = await applyReviewItemCategory(item, 'manual', input.userId, {
        confidence: 1,
        evidence: { acceptedExternalSignal: true, externalConfidence: item.payload.confidence ?? null, source: 'review_center' },
        invalidateAiCache: true,
      });
      await recordAcceptedSuggestionFeedback(item, 'external_suggestion_accepted', input.userId, !input.skipLearning);
    } else if (item.type === 'receipt_category_override') {
      appliedCount = await applyReviewItemCategory(item, 'receipt_evidence', input.userId, { invalidateAiCache: true });
    } else if (isRuleContradictionItem(item)) {
      // The listed transactions are already set by hand; accepting switches the rule itself.
      appliedCount = await acceptRuleContradiction(item, input.userId);
    } else if (item.type === 'rule_conflict_review') {
      appliedCount = await applyReviewItemCategory(item, 'user_confirmed_rule', input.userId, { invalidateAiCache: true });
    }
  }

  const [updated] = await db
    .update(categorizationReviewItems)
    .set({
      status: input.action === 'accept' ? 'accepted' : 'dismissed',
      resolvedAction: input.action,
      resolvedByUserId: input.userId,
      resolvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(categorizationReviewItems.id, item.id))
    .returning();

  return {
    item: updated ?? item,
    appliedCount,
    conflictCount,
  };
}

export function acceptedAiSuggestionEvidence(aiConfidence: number | null | undefined): Record<string, unknown> {
  return {
    acceptedAiSuggestion: true,
    aiConfidence: aiConfidence ?? null,
    source: 'review_center',
  };
}

/**
 * An accepted suggestion is a human confirmation — feed it back as an AI example, and let
 * it count toward auto-learning the merchant (two accepted suggestions ⇒ a rule).
 */
async function recordAcceptedSuggestionFeedback(
  item: CategorizationReviewItem,
  source: 'ai_suggestion_accepted' | 'external_suggestion_accepted',
  userId: string | undefined,
  evaluateLearning: boolean,
): Promise<void> {
  const categoryId = item.payload.proposedCategoryId;
  const transactionId = item.payload.transactionId ?? item.payload.transactionIds?.[0];
  if (!categoryId || !transactionId) return;
  const transaction = await db.query.transactions.findFirst({ where: eq(transactions.id, transactionId) });
  if (!transaction || transaction.amountCents >= 0) return;
  const normalizedMerchant = normalize(transaction.merchant);
  if (!isLearnableMerchant(normalizedMerchant)) return;
  await db.insert(categorizationFeedback).values({
    businessId: transaction.businessId,
    transactionId: transaction.id,
    merchant: transaction.merchant,
    normalizedMerchant,
    previousCategoryId: item.payload.currentCategoryId ?? null,
    newCategoryId: categoryId,
    source,
    payload: { reviewItemId: item.id },
    createdByUserId: userId,
  });
  if (evaluateLearning) {
    await evaluateMerchantLearning({
      businessId: transaction.businessId,
      merchant: transaction.merchant,
      categoryId,
      transactionIds: [transaction.id],
      userId,
      human: true,
    });
  }
}

export async function scanUncategorizedTransactions(input: { businessId?: string; limit?: number } = {}): Promise<number> {
  const uncategorized = await fallbackUncategorizedCategory();
  const rows = await db
    .select()
    .from(transactions)
    .where(and(
      input.businessId ? eq(transactions.businessId, input.businessId) : sql`true`,
      sql`${transactions.amountCents} < 0`,
      uncategorized
        ? or(isNull(transactions.categoryId), eq(transactions.categoryId, uncategorized.id))
        : isNull(transactions.categoryId),
    ))
    .orderBy(desc(transactions.date), desc(transactions.createdAt))
    .limit(input.limit ?? 200);

  let touched = 0;
  for (const transaction of rows) {
    const result = await categorizeTransactionWithDetails({
      businessId: transaction.businessId,
      merchant: transaction.merchant,
      amountCents: transaction.amountCents,
      plaidCategory: plaidCategoryHints(transaction.raw),
    });
    if (!result.categoryId || result.source === 'uncategorized') continue;
    // Same bar as Plaid sync: confident AI verdicts apply, the rest go to review.
    if (result.source === 'ai_suggested' && !shouldAutoApplyAiSuggestion(result)) {
      await createAiCategorySuggestionReview(transaction, result);
      touched += 1;
      continue;
    }
    await updateTransactionCategory({
      transaction,
      newCategoryId: result.categoryId,
      source: result.source,
      confidence: result.confidence,
      evidence: result.evidence,
    });
    touched += 1;
  }
  return touched;
}

export async function reviewReceiptCategoryEvidence(input: {
  transactionId: string;
  receiptId: string;
  matchScore?: number | null;
}): Promise<CategorizationReviewItem | null> {
  const [transaction, receipt] = await Promise.all([
    db.query.transactions.findFirst({ where: eq(transactions.id, input.transactionId) }),
    db.query.receipts.findFirst({ where: eq(receipts.id, input.receiptId) }),
  ]);
  if (!transaction || !receipt || transaction.amountCents >= 0) return null;

  const inferred = await inferReceiptCategory(receipt, transaction);
  if (!inferred.categoryId || inferred.categoryId === transaction.categoryId) return null;

  const category = await db.query.categories.findFirst({ where: eq(categories.id, inferred.categoryId) });
  if (!category) return null;

  const matchScore = input.matchScore ?? await latestReceiptMatchScore(input.receiptId, input.transactionId);
  const receiptConfidence = parseConfidence(receipt.confidence);
  const evidence = {
    ...inferred.evidence,
    receiptId: receipt.id,
    receiptMerchant: receipt.merchant,
    receiptTotalCents: receipt.totalCents,
    receiptDate: receipt.receiptDate,
    receiptConfidence,
    matchScore,
  };
  const confident = receiptEvidenceCanAutoApply({
    matchScore,
    receiptConfidence,
    categoryConfidence: inferred.confidence,
    categorySource: transaction.categorySource,
  });

  if (confident) {
    await updateTransactionCategory({
      transaction,
      newCategoryId: inferred.categoryId,
      source: 'receipt_evidence',
      confidence: inferred.confidence,
      evidence,
    });
    return null;
  }

  return upsertReviewItem({
    businessId: transaction.businessId,
    type: 'receipt_category_override',
    fingerprint: `receipt:${receipt.id}:${transaction.id}:${inferred.categoryId}`,
    title: `Receipt suggests ${category.name}`,
    detail: `${receipt.merchant ?? transaction.merchant} receipt evidence conflicts with the current transaction category.`,
    payload: {
      transactionId: transaction.id,
      transactionIds: [transaction.id],
      merchant: transaction.merchant,
      currentCategoryId: transaction.categoryId,
      proposedCategoryId: inferred.categoryId,
      proposedCategoryName: category.name,
      confidence: inferred.confidence,
      evidence,
    },
  });
}

export async function createAiCategorySuggestionReview(
  transaction: Transaction,
  result: Awaited<ReturnType<typeof categorizeTransactionWithDetails>>,
): Promise<CategorizationReviewItem | null> {
  if (!result.categoryId) return null;
  const category = await db.query.categories.findFirst({ where: eq(categories.id, result.categoryId) });
  if (!category) return null;
  return upsertReviewItem({
    businessId: transaction.businessId,
    type: 'ai_category_suggestion',
    fingerprint: `ai:${transaction.id}:${result.categoryId}`,
    title: `Categorize ${transaction.merchant}`,
    detail: `AI suggests ${category.name} for this uncategorized transaction.`,
    payload: {
      transactionId: transaction.id,
      transactionIds: [transaction.id],
      merchant: transaction.merchant,
      currentCategoryId: transaction.categoryId,
      proposedCategoryId: result.categoryId,
      proposedCategoryName: category.name,
      confidence: result.confidence ?? undefined,
      evidence: result.evidence,
    },
  });
}

async function fallbackUncategorizedCategory() {
  return db.query.categories.findFirst({
    where: and(isNull(categories.businessId), eq(categories.name, 'Uncategorized')),
  });
}
