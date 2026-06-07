import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  categories,
  categorizationReviewItems,
  categoryRules,
  transactionCategoryEvents,
  transactions,
  type CategorySource,
  type CategorizationReviewItem,
  type CategorizationReviewPayload,
  type CategorizationReviewType,
  type Transaction,
} from '../db/schema.js';

export async function acceptLearningRule(item: CategorizationReviewItem, userId?: string): Promise<{
  appliedCount: number;
  conflictCount: number;
}> {
  const payload = item.payload;
  if (!payload.proposedCategoryId || !payload.proposedRule?.pattern) {
    return { appliedCount: 0, conflictCount: 0 };
  }
  await upsertMerchantRule({
    businessId: item.businessId,
    categoryId: payload.proposedCategoryId,
    pattern: payload.proposedRule.pattern,
  });

  const matches = await matchingTransactions(item.businessId, payload.proposedRule.pattern);
  const uncategorizedIds = matches
    .filter((match) => !match.categoryId || match.categoryName === 'Uncategorized')
    .map((match) => match.id);
  const conflictIds = matches
    .filter((match) => match.categoryId && match.categoryId !== payload.proposedCategoryId && match.categoryName !== 'Uncategorized')
    .map((match) => match.id);

  let appliedCount = 0;
  if (uncategorizedIds.length) {
    const affected = await db.select().from(transactions).where(inArray(transactions.id, uncategorizedIds));
    for (const transaction of affected) {
      await updateTransactionCategory({
        transaction,
        newCategoryId: payload.proposedCategoryId,
        source: 'user_confirmed_rule',
        confidence: 1,
        evidence: { reviewItemId: item.id, rulePattern: payload.proposedRule.pattern },
        userId,
      });
      appliedCount += 1;
    }
  }

  if (conflictIds.length) {
    const category = await db.query.categories.findFirst({ where: eq(categories.id, payload.proposedCategoryId) });
    await upsertReviewItem({
      businessId: item.businessId,
      type: 'rule_conflict_review',
      fingerprint: `conflict:${payload.proposedRule.pattern}:${payload.proposedCategoryId}:${conflictIds.sort().join(',')}`,
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

  return { appliedCount, conflictCount: conflictIds.length };
}

export async function applyReviewItemCategory(
  item: CategorizationReviewItem,
  source: CategorySource,
  userId?: string,
): Promise<number> {
  const categoryId = item.payload.proposedCategoryId;
  const ids = [
    ...(item.payload.transactionIds ?? []),
    ...(item.payload.transactionId ? [item.payload.transactionId] : []),
  ];
  const uniqueIds = [...new Set(ids)];
  if (!categoryId || uniqueIds.length === 0) return 0;

  const affected = await db.select().from(transactions).where(inArray(transactions.id, uniqueIds));
  let count = 0;
  for (const transaction of affected) {
    await updateTransactionCategory({
      transaction,
      newCategoryId: categoryId,
      source,
      confidence: item.payload.confidence ?? 1,
      evidence: {
        reviewItemId: item.id,
        ...(item.payload.evidence ?? {}),
      },
      userId,
    });
    count += 1;
  }
  return count;
}

export async function upsertReviewItem(input: {
  businessId: string;
  type: CategorizationReviewType;
  fingerprint: string;
  title: string;
  detail: string;
  payload: CategorizationReviewPayload;
}): Promise<CategorizationReviewItem> {
  const existing = await db.query.categorizationReviewItems.findFirst({
    where: and(
      eq(categorizationReviewItems.businessId, input.businessId),
      eq(categorizationReviewItems.type, input.type),
      eq(categorizationReviewItems.status, 'open'),
      eq(categorizationReviewItems.fingerprint, input.fingerprint),
    ),
  });
  if (existing) {
    const [updated] = await db
      .update(categorizationReviewItems)
      .set({
        title: input.title,
        detail: input.detail,
        payload: input.payload,
        updatedAt: new Date(),
      })
      .where(eq(categorizationReviewItems.id, existing.id))
      .returning();
    return updated ?? existing;
  }

  const [item] = await db
    .insert(categorizationReviewItems)
    .values({
      businessId: input.businessId,
      type: input.type,
      fingerprint: input.fingerprint,
      title: input.title,
      detail: input.detail,
      payload: input.payload,
    })
    .returning();
  return item;
}

export async function updateTransactionCategory(input: {
  transaction: Transaction;
  newCategoryId: string;
  source: CategorySource;
  confidence: number | null;
  evidence: Record<string, unknown>;
  userId?: string;
}): Promise<void> {
  await db
    .update(transactions)
    .set({
      categoryId: input.newCategoryId,
      categorySource: input.source,
      categoryConfidence: input.confidence == null ? null : input.confidence.toFixed(4),
      categoryEvidence: input.evidence,
      updatedAt: new Date(),
    })
    .where(eq(transactions.id, input.transaction.id));

  await recordCategoryEvent({
    transaction: input.transaction,
    previousCategoryId: input.transaction.categoryId,
    newCategoryId: input.newCategoryId,
    source: input.source,
    confidence: input.confidence,
    evidence: input.evidence,
    userId: input.userId,
  });
}

export async function recordCategoryEvent(input: {
  transaction: Transaction;
  previousCategoryId: string | null;
  newCategoryId: string | null;
  source: CategorySource;
  confidence: number | null;
  evidence: Record<string, unknown>;
  userId?: string;
}): Promise<void> {
  if (input.previousCategoryId === input.newCategoryId && input.source !== 'manual') return;
  await db.insert(transactionCategoryEvents).values({
    businessId: input.transaction.businessId,
    transactionId: input.transaction.id,
    previousCategoryId: input.previousCategoryId,
    newCategoryId: input.newCategoryId,
    source: input.source,
    confidence: input.confidence == null ? null : input.confidence.toFixed(4),
    evidence: input.evidence,
    createdByUserId: input.userId,
  });
}

export async function countRuleMatches(
  businessId: string,
  normalizedMerchant: string,
  proposedCategoryId: string,
): Promise<{ uncategorized: number; conflicts: number }> {
  const matches = await matchingTransactions(businessId, normalizedMerchant);
  return {
    uncategorized: matches.filter((match) => !match.categoryId || match.categoryName === 'Uncategorized').length,
    conflicts: matches.filter((match) => (
      match.categoryId && match.categoryId !== proposedCategoryId && match.categoryName !== 'Uncategorized'
    )).length,
  };
}

async function upsertMerchantRule(input: {
  businessId: string;
  categoryId: string;
  pattern: string;
}): Promise<void> {
  const existing = await db.query.categoryRules.findFirst({
    where: and(
      eq(categoryRules.businessId, input.businessId),
      eq(categoryRules.matchKind, 'merchant_exact'),
      eq(categoryRules.pattern, input.pattern),
    ),
  });
  if (existing) {
    await db
      .update(categoryRules)
      .set({
        categoryId: input.categoryId,
        priority: 1,
        createdByAi: false,
        updatedAt: new Date(),
      })
      .where(eq(categoryRules.id, existing.id));
    return;
  }
  await db.insert(categoryRules).values({
    businessId: input.businessId,
    categoryId: input.categoryId,
    matchKind: 'merchant_exact',
    pattern: input.pattern,
    priority: 1,
    createdByAi: false,
  });
}

async function matchingTransactions(businessId: string, normalizedMerchant: string): Promise<Array<{
  id: string;
  categoryId: string | null;
  categoryName: string | null;
}>> {
  return db
    .select({
      id: transactions.id,
      categoryId: transactions.categoryId,
      categoryName: categories.name,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(and(
      eq(transactions.businessId, businessId),
      sql`${transactions.amountCents} < 0`,
      sql`trim(regexp_replace(lower(${transactions.merchant}), '[^a-z0-9]+', ' ', 'g')) = ${normalizedMerchant}`,
    ))
    .orderBy(desc(transactions.date), asc(transactions.id));
}
