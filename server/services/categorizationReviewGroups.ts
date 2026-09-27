import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  businesses,
  categories,
  categorizationFeedback,
  categorizationReviewItems,
  categoryRules,
  transactions,
  type CategorizationReviewItem,
  type CategorizationReviewType,
} from '../db/schema.js';
import { normalize } from './categorization.js';
import { resolveCategorizationReviewItem, type ReviewResolutionAction } from './categorizationFeedback.js';
import { isLearnableMerchant, learnMerchantRule } from './categorizationLearning.js';

/**
 * Review items grouped by (business, normalized merchant, proposed category) so twelve
 * "Categorize UBER" suggestions are one decision, not twelve.
 */

export interface ReviewGroupTransaction {
  id: string;
  date: string;
  merchant: string;
  amountCents: number;
  categoryId: string | null;
  categoryName: string | null;
}

export interface ReviewGroup {
  groupKey: string;
  businessId: string;
  biz: string | null;
  merchant: string;
  normalizedMerchant: string;
  proposedCategoryId: string | null;
  proposedCategoryName: string | null;
  types: CategorizationReviewType[];
  itemIds: string[];
  itemCount: number;
  transactionCount: number;
  /** Sum of |amount| across the group's distinct transactions. */
  totalCents: number;
  /** Confidence range of machine suggestions (AI / external) in the group; null if none. */
  confidence: { min: number; max: number } | null;
  sampleTransactions: ReviewGroupTransaction[];
  /** Accepting creates a trusted merchant rule (false for receipt-only / merchant-less groups). */
  learnsRule: boolean;
  oldestCreatedAt: string;
  newestCreatedAt: string;
}

export type GroupableReviewItem = Pick<CategorizationReviewItem, 'id' | 'businessId' | 'type' | 'title' | 'payload' | 'createdAt'> & {
  businessKey?: string | null;
};

const SUGGESTION_TYPES: ReadonlySet<CategorizationReviewType> = new Set(['ai_category_suggestion', 'external_category_suggestion']);
/** Receipt evidence is about one purchase (Amazon → Office Supplies), not the merchant. */
const RULE_LEARNING_TYPES: ReadonlySet<CategorizationReviewType> = new Set([
  'learn_rule_prompt',
  'ai_category_suggestion',
  'external_category_suggestion',
  'rule_conflict_review',
]);
const SAMPLE_SIZE = 3;

export function reviewItemMerchant(item: Pick<CategorizationReviewItem, 'title' | 'payload'>): { merchant: string; normalizedMerchant: string } {
  const merchant = item.payload.merchant ?? item.payload.proposedRule?.pattern ?? item.title;
  const normalizedMerchant = item.payload.normalizedMerchant ?? item.payload.proposedRule?.pattern ?? normalize(merchant);
  return { merchant, normalizedMerchant };
}

export function reviewGroupKey(businessId: string, normalizedMerchant: string, proposedCategoryId: string | null | undefined): string {
  return `${businessId}|${normalizedMerchant}|${proposedCategoryId ?? ''}`;
}

export function reviewItemTransactionIds(item: Pick<CategorizationReviewItem, 'payload'>): string[] {
  return [...new Set([
    ...(item.payload.transactionIds ?? []),
    ...(item.payload.transactionId ? [item.payload.transactionId] : []),
  ])];
}

/** Pure grouping — the route loads items + referenced transactions and hands them in. */
export function groupReviewItems(
  items: GroupableReviewItem[],
  transactionsById: Map<string, ReviewGroupTransaction>,
): ReviewGroup[] {
  const groups = new Map<string, ReviewGroup & { transactionIdSet: Set<string> }>();
  for (const item of items) {
    const { merchant, normalizedMerchant } = reviewItemMerchant(item);
    const proposedCategoryId = item.payload.proposedCategoryId ?? null;
    const key = reviewGroupKey(item.businessId, normalizedMerchant, proposedCategoryId);
    const createdAt = item.createdAt.toISOString();
    let group = groups.get(key);
    if (!group) {
      group = {
        groupKey: key,
        businessId: item.businessId,
        biz: item.businessKey ?? null,
        merchant,
        normalizedMerchant,
        proposedCategoryId,
        proposedCategoryName: item.payload.proposedCategoryName ?? null,
        types: [],
        itemIds: [],
        itemCount: 0,
        transactionCount: 0,
        totalCents: 0,
        confidence: null,
        sampleTransactions: [],
        learnsRule: false,
        oldestCreatedAt: createdAt,
        newestCreatedAt: createdAt,
        transactionIdSet: new Set(),
      };
      groups.set(key, group);
    }
    group.itemIds.push(item.id);
    group.itemCount += 1;
    if (!group.types.includes(item.type)) group.types.push(item.type);
    if (!group.proposedCategoryName && item.payload.proposedCategoryName) group.proposedCategoryName = item.payload.proposedCategoryName;
    if (createdAt < group.oldestCreatedAt) group.oldestCreatedAt = createdAt;
    if (createdAt > group.newestCreatedAt) group.newestCreatedAt = createdAt;
    if (SUGGESTION_TYPES.has(item.type) && typeof item.payload.confidence === 'number') {
      const value = item.payload.confidence;
      group.confidence = group.confidence
        ? { min: Math.min(group.confidence.min, value), max: Math.max(group.confidence.max, value) }
        : { min: value, max: value };
    }
    for (const id of reviewItemTransactionIds(item)) group.transactionIdSet.add(id);
  }

  return [...groups.values()]
    .map(({ transactionIdSet, ...group }) => {
      const rows = [...transactionIdSet]
        .map((id) => transactionsById.get(id))
        .filter((row): row is ReviewGroupTransaction => Boolean(row))
        .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
      return {
        ...group,
        transactionCount: transactionIdSet.size,
        totalCents: rows.reduce((sum, row) => sum + Math.abs(row.amountCents), 0),
        sampleTransactions: rows.slice(0, SAMPLE_SIZE),
        learnsRule: Boolean(group.proposedCategoryId)
          && isLearnableMerchant(group.normalizedMerchant)
          && group.types.every((type) => RULE_LEARNING_TYPES.has(type)),
      };
    })
    .sort((a, b) => b.itemCount - a.itemCount || b.totalCents - a.totalCents || a.groupKey.localeCompare(b.groupKey));
}

const OPEN_ITEM_LIMIT = 2000;

async function openReviewItems(filter: { businessKey?: string; businessId?: string }): Promise<GroupableReviewItem[]> {
  const rows = await db
    .select({ item: categorizationReviewItems, businessKey: businesses.key })
    .from(categorizationReviewItems)
    .innerJoin(businesses, eq(categorizationReviewItems.businessId, businesses.id))
    .where(and(
      eq(categorizationReviewItems.status, 'open'),
      filter.businessKey && filter.businessKey !== 'all' ? eq(businesses.key, filter.businessKey) : sql`true`,
      filter.businessId ? eq(categorizationReviewItems.businessId, filter.businessId) : sql`true`,
    ))
    .orderBy(desc(categorizationReviewItems.createdAt))
    .limit(OPEN_ITEM_LIMIT);
  return rows.map((row) => ({ ...row.item, businessKey: row.businessKey }));
}

async function transactionsFor(ids: string[]): Promise<Map<string, ReviewGroupTransaction>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select({
      id: transactions.id,
      date: transactions.date,
      merchant: transactions.merchant,
      amountCents: transactions.amountCents,
      categoryId: transactions.categoryId,
      categoryName: categories.name,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(inArray(transactions.id, ids));
  return new Map(rows.map((row) => [row.id, { ...row, categoryName: row.categoryName ?? null }]));
}

export async function listReviewGroups(input: { businessKey?: string } = {}): Promise<ReviewGroup[]> {
  const items = await openReviewItems({ businessKey: input.businessKey });
  const ids = [...new Set(items.flatMap(reviewItemTransactionIds))];
  return groupReviewItems(items, await transactionsFor(ids));
}

/** Count of open decisions (groups) — cheap, no transaction lookups. */
export async function countOpenReviewGroups(input: { businessKey?: string } = {}): Promise<{ items: number; groups: number }> {
  const items = await openReviewItems({ businessKey: input.businessKey });
  return { items: items.length, groups: groupReviewItems(items, new Map()).length };
}

export interface ResolveGroupResult {
  groupKey: string;
  action: ReviewResolutionAction;
  resolvedCount: number;
  appliedCount: number;
  conflictCount: number;
  learnedRuleId: string | null;
  relabelledCount: number;
}

/**
 * Resolve every open item in a group. Accepting also confirms the merchant → category
 * mapping: a trusted rule is learned (logged, undoable) so future ones auto-apply.
 * `itemIds` restricts to what the user actually saw (items that arrived later stay open).
 */
export async function resolveReviewGroup(input: {
  groupKey: string;
  action: ReviewResolutionAction;
  itemIds?: string[];
  userId?: string;
}): Promise<ResolveGroupResult | null> {
  const businessId = input.groupKey.split('|')[0];
  if (!businessId || !/^[0-9a-f-]{36}$/i.test(businessId)) return null;
  const items = await openReviewItems({ businessId });
  const restrict = input.itemIds ? new Set(input.itemIds) : null;
  const group = groupReviewItems(items, new Map()).find((candidate) => candidate.groupKey === input.groupKey);
  if (!group) return null;
  const targetIds = group.itemIds.filter((id) => !restrict || restrict.has(id));
  if (!targetIds.length) return null;

  let resolvedCount = 0;
  let appliedCount = 0;
  let conflictCount = 0;
  for (const id of targetIds) {
    const result = await resolveCategorizationReviewItem({
      id,
      action: input.action,
      userId: input.userId,
      skipLearning: true,
    });
    if (!result) continue;
    resolvedCount += 1;
    appliedCount += result.appliedCount;
    conflictCount += result.conflictCount;
  }

  let learnedRuleId: string | null = null;
  let relabelledCount = 0;
  if (input.action === 'accept' && group.learnsRule && group.proposedCategoryId) {
    const targetItems = items.filter((item) => targetIds.includes(item.id));
    const sourceTransactionIds = [...new Set(targetItems.flatMap(reviewItemTransactionIds))];
    const existing = await db.query.categoryRules.findFirst({
      where: and(
        eq(categoryRules.businessId, group.businessId),
        eq(categoryRules.matchKind, 'merchant_exact'),
        eq(categoryRules.pattern, group.normalizedMerchant),
      ),
    });
    // A learn prompt / contradiction accept inside the group may have learned it already.
    if (!(existing?.userConfirmed && existing.categoryId === group.proposedCategoryId)) {
      await recordGroupAcceptFeedback(group, sourceTransactionIds, input.userId);
      const learned = await learnMerchantRule({
        businessId: group.businessId,
        merchant: group.merchant,
        normalizedMerchant: group.normalizedMerchant,
        categoryId: group.proposedCategoryId,
        learnedVia: 'review_group_accepted',
        sourceTransactionIds,
        userId: input.userId,
      });
      learnedRuleId = learned?.learnedRule.id ?? null;
      relabelledCount = learned?.appliedCount ?? 0;
    }
  }

  return {
    groupKey: input.groupKey,
    action: input.action,
    resolvedCount,
    appliedCount,
    conflictCount,
    learnedRuleId,
    relabelledCount,
  };
}

/** One AI example for the whole group decision (not one per item). */
async function recordGroupAcceptFeedback(group: ReviewGroup, transactionIds: string[], userId?: string): Promise<void> {
  if (!group.proposedCategoryId || !transactionIds.length) return;
  const existing = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(inArray(transactions.id, transactionIds));
  await db.insert(categorizationFeedback).values({
    businessId: group.businessId,
    transactionId: existing[0]?.id ?? null,
    merchant: group.merchant,
    normalizedMerchant: group.normalizedMerchant,
    previousCategoryId: null,
    newCategoryId: group.proposedCategoryId,
    source: 'review_group_accepted',
    payload: { transactionIds, groupKey: group.groupKey },
    createdByUserId: userId,
  });
}
