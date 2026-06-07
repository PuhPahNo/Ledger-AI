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
} from './categorization.js';
import {
  acceptLearningRule,
  applyReviewItemCategory,
  countRuleMatches,
  recordCategoryEvent,
  updateTransactionCategory,
  upsertReviewItem,
} from './categorizationReviewActions.js';
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

export async function createManualCategorizationFeedback(input: {
  transaction: Transaction;
  previousCategoryId: string | null;
  newCategoryId: string;
  userId?: string;
}): Promise<CategorizationReviewItem | null> {
  if (input.transaction.amountCents >= 0) return null;
  const category = await db.query.categories.findFirst({ where: eq(categories.id, input.newCategoryId) });
  if (!category || categoryMatchesTransactionDirection(category, input.transaction.amountCents) === false) return null;

  const normalizedMerchant = normalize(input.transaction.merchant);
  if (!normalizedMerchant || normalizedMerchant === 'unknown merchant') return null;

  await db.insert(categorizationFeedback).values({
    businessId: input.transaction.businessId,
    transactionId: input.transaction.id,
    merchant: input.transaction.merchant,
    normalizedMerchant,
    previousCategoryId: input.previousCategoryId,
    newCategoryId: input.newCategoryId,
    source: 'manual',
    payload: { reason: 'transaction_category_edit' },
    createdByUserId: input.userId,
  });

  await recordCategoryEvent({
    transaction: input.transaction,
    previousCategoryId: input.previousCategoryId,
    newCategoryId: input.newCategoryId,
    source: 'manual',
    confidence: 1,
    evidence: { reason: 'manual_transaction_edit' },
    userId: input.userId,
  });

  const counts = await countRuleMatches(input.transaction.businessId, normalizedMerchant, input.newCategoryId);
  return upsertReviewItem({
    businessId: input.transaction.businessId,
    type: 'learn_rule_prompt',
    fingerprint: `learn:${normalizedMerchant}:${input.newCategoryId}`,
    title: `Learn ${input.transaction.merchant}`,
    detail: `Use ${category.name} for matching future ${input.transaction.merchant} transactions?`,
    payload: {
      transactionId: input.transaction.id,
      transactionIds: [input.transaction.id],
      merchant: input.transaction.merchant,
      normalizedMerchant,
      currentCategoryId: input.previousCategoryId,
      proposedCategoryId: input.newCategoryId,
      proposedCategoryName: category.name,
      proposedRule: {
        matchKind: 'merchant_exact',
        pattern: normalizedMerchant,
        priority: 1,
      },
      confidence: 1,
      evidence: { source: 'manual_transaction_edit' },
      matchCounts: counts,
    },
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
      appliedCount = await applyReviewItemCategory(item, 'ai_suggested', input.userId);
    } else if (item.type === 'receipt_category_override') {
      appliedCount = await applyReviewItemCategory(item, 'receipt_evidence', input.userId);
    } else if (item.type === 'rule_conflict_review') {
      appliedCount = await applyReviewItemCategory(item, 'user_confirmed_rule', input.userId);
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
    .limit(input.limit ?? 50);

  let touched = 0;
  for (const transaction of rows) {
    const result = await categorizeTransactionWithDetails({
      businessId: transaction.businessId,
      merchant: transaction.merchant,
      amountCents: transaction.amountCents,
      plaidCategory: plaidCategoryHints(transaction.raw),
    });
    if (!result.categoryId || result.source === 'uncategorized') continue;
    if (result.source === 'ai_suggested') {
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
