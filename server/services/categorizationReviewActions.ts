import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  categories,
  categorizationReviewItems,
  categoryRules,
  transactionCategoryEvents,
  transactions,
  type CategoryRule,
  type CategorySource,
  type CategorizationReviewItem,
  type CategorizationReviewPayload,
  type CategorizationReviewType,
  type Transaction,
} from '../db/schema.js';
import {
  PROTECTED_CATEGORY_SOURCES,
  invalidateAiCategorizationCache,
  merchantPrefilterSql,
  normalize,
} from './categorization.js';
import { applyTagRulesBestEffort } from './tagging.js';

export { PROTECTED_CATEGORY_SOURCES };

export async function applyReviewItemCategory(
  item: CategorizationReviewItem,
  source: CategorySource,
  userId?: string,
  options: {
    confidence?: number;
    evidence?: Record<string, unknown>;
    /** A human picked a category the AI cache may disagree with — drop the stale verdict. */
    invalidateAiCache?: boolean;
  } = {},
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
      confidence: options.confidence ?? item.payload.confidence ?? 1,
      evidence: {
        reviewItemId: item.id,
        ...(item.payload.evidence ?? {}),
        ...(options.evidence ?? {}),
      },
      userId,
    });
    if (options.invalidateAiCache) await invalidateAiCategorizationCache(transaction);
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
  await applyTagRulesBestEffort(input.transaction.id);
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

/**
 * Learned merchant rules are one-per-(business, pattern). A single INSERT … ON CONFLICT
 * against the partial unique index (migration 0023) so two concurrent accepts can't
 * insert duplicates. Accepting a learn prompt is an explicit human confirmation.
 */
export async function upsertMerchantRule(input: {
  businessId: string;
  categoryId: string;
  pattern: string;
}): Promise<CategoryRule> {
  const [rule] = await db
    .insert(categoryRules)
    .values({
      businessId: input.businessId,
      categoryId: input.categoryId,
      matchKind: 'merchant_exact',
      pattern: input.pattern,
      priority: 1,
      createdByAi: false,
      userConfirmed: true,
    })
    .onConflictDoUpdate({
      target: [categoryRules.businessId, categoryRules.pattern],
      targetWhere: sql.raw(`match_kind = 'merchant_exact' AND business_id IS NOT NULL`),
      set: {
        categoryId: input.categoryId,
        priority: 1,
        userConfirmed: true,
        updatedAt: new Date(),
      },
    })
    .returning();
  return rule;
}

export async function matchingTransactions(businessId: string, normalizedMerchant: string): Promise<Array<{
  id: string;
  categoryId: string | null;
  categoryName: string | null;
  categorySource: string;
}>> {
  // Merchant normalization (processor prefixes, store numbers) lives in normalize() and is
  // too fiddly to mirror exactly in SQL. SQL narrows to this business's spend whose raw
  // merchant contains every pattern word (a superset of the true matches); the exact
  // normalize() comparison then runs in JS on that small set.
  const rows = await db
    .select({
      id: transactions.id,
      merchant: transactions.merchant,
      categoryId: transactions.categoryId,
      categoryName: categories.name,
      categorySource: transactions.categorySource,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(and(
      eq(transactions.businessId, businessId),
      sql`${transactions.amountCents} < 0`,
      merchantPrefilterSql(transactions.merchant, normalizedMerchant),
    ))
    .orderBy(desc(transactions.date), asc(transactions.id));
  return rows
    .filter((row) => normalize(row.merchant) === normalizedMerchant)
    .map(({ merchant: _merchant, ...row }) => row);
}
