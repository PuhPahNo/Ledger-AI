import OpenAI from 'openai';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';
import { getEnv } from '../config/env.js';
import { db } from '../db/client.js';
import {
  categories,
  businesses,
  categorizationFeedback,
  categorizationReviewItems,
  categoryRules,
  receiptMatches,
  receipts,
  transactionCategoryEvents,
  transactions,
  type Category,
  type CategorySource,
  type CategorizationReviewItem,
  type CategorizationReviewPayload,
  type CategorizationReviewType,
  type Receipt,
  type Transaction,
} from '../db/schema.js';
import {
  categoryMatchesTransactionDirection,
  categoryNameForKnownSignals,
  categorizeTransactionWithDetails,
  normalize,
} from './categorization.js';

export type ReviewResolutionAction = 'accept' | 'dismiss';

export interface CategorizationReviewSummary {
  item: CategorizationReviewItem;
  appliedCount: number;
  conflictCount: number;
}

const receiptAutoMatchThreshold = 0.82;
const receiptExtractionThreshold = 0.85;
const receiptCategoryThreshold = 0.8;

const receiptCategorySchema = z.object({
  categoryId: z.string().uuid().nullable(),
  confidence: z.number().min(0).max(1),
  evidence: z.string().nullable(),
});

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

async function acceptLearningRule(item: CategorizationReviewItem, userId?: string): Promise<{
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

async function applyReviewItemCategory(
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

async function upsertReviewItem(input: {
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

async function updateTransactionCategory(input: {
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

async function recordCategoryEvent(input: {
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

async function countRuleMatches(
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

async function inferReceiptCategory(receipt: Receipt, transaction: Transaction): Promise<{
  categoryId: string | null;
  confidence: number;
  evidence: Record<string, unknown>;
}> {
  const availableCategories = await db
    .select()
    .from(categories)
    .where(and(
      eq(categories.active, true),
      or(eq(categories.businessId, transaction.businessId), isNull(categories.businessId)),
    ))
    .orderBy(asc(categories.name));
  const eligible = availableCategories.filter((category) => (
    categoryMatchesTransactionDirection(category, transaction.amountCents)
  ));
  const evidenceText = receiptEvidenceText(receipt, transaction);
  const hintedName = categoryNameFromReceiptJson(receipt.ocrJson);
  const hintedCategory = hintedName ? findPreferredCategoryByName(eligible, hintedName, transaction.businessId) : null;
  if (hintedCategory) {
    return {
      categoryId: hintedCategory.id,
      confidence: receiptCategoryConfidence(receipt.ocrJson, 0.84),
      evidence: { source: 'receipt_category_hint', hintedName, evidenceText },
    };
  }

  const signalName = categoryNameForKnownSignals({
    businessId: transaction.businessId,
    merchant: `${receipt.merchant ?? ''} ${transaction.merchant}`,
    amountCents: transaction.amountCents,
    plaidCategory: [evidenceText],
  });
  const signalCategory = signalName ? findPreferredCategoryByName(eligible, signalName, transaction.businessId) : null;
  if (signalCategory) {
    return {
      categoryId: signalCategory.id,
      confidence: 0.82,
      evidence: { source: 'receipt_signal_mapping', signalName, evidenceText },
    };
  }

  const aiSuggestion = await inferReceiptCategoryWithAi(receipt, transaction, eligible, evidenceText);
  return aiSuggestion ?? { categoryId: null, confidence: 0, evidence: { reason: 'no_receipt_category_match' } };
}

async function inferReceiptCategoryWithAi(
  receipt: Receipt,
  transaction: Transaction,
  availableCategories: Category[],
  evidenceText: string,
): Promise<{ categoryId: string | null; confidence: number; evidence: Record<string, unknown> } | null> {
  const env = getEnv();
  if (!env.OPENAI_API_KEY || availableCategories.length === 0) return null;
  try {
    const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    const response = await client.responses.parse({
      model: env.OPENAI_CATEGORIZATION_MODEL,
      input: [{
        role: 'user',
        content: [{
          type: 'input_text',
          text: [
            'Use receipt evidence to choose the best Ledger AI business expense category.',
            'Choose exactly one categoryId from the provided list, or null if the receipt evidence is not enough.',
            'Do not choose an income category for an outflow.',
            `Transaction: ${JSON.stringify({
              merchant: transaction.merchant,
              amountCents: transaction.amountCents,
              plaidCategory: plaidCategoryHints(transaction.raw),
            })}`,
            `Receipt: ${JSON.stringify({
              merchant: receipt.merchant,
              totalCents: receipt.totalCents,
              receiptDate: receipt.receiptDate,
              ocrJson: receipt.ocrJson,
              evidenceText,
            })}`,
            `Categories: ${JSON.stringify(availableCategories.map((category) => ({
              id: category.id,
              name: category.name,
              taxCode: category.taxCode,
            })))}`,
          ].join('\n'),
        }],
      }],
      text: {
        format: zodTextFormat(receiptCategorySchema, 'receipt_category'),
      },
    });
    const message = response.output.find((item) => item.type === 'message');
    const parsed = message?.content.find((item) => item.type === 'output_text')?.parsed;
    const suggestion = receiptCategorySchema.parse(parsed);
    const exists = availableCategories.some((category) => category.id === suggestion.categoryId);
    if (!exists) return null;
    return {
      categoryId: suggestion.categoryId,
      confidence: suggestion.confidence,
      evidence: { source: 'receipt_ai', reason: suggestion.evidence, evidenceText },
    };
  } catch {
    return null;
  }
}

export function receiptEvidenceCanAutoApply(input: {
  matchScore?: number | null;
  receiptConfidence: number;
  categoryConfidence: number;
  categorySource: CategorySource;
}): boolean {
  return (input.matchScore ?? 0) >= receiptAutoMatchThreshold
    && input.receiptConfidence >= receiptExtractionThreshold
    && input.categoryConfidence >= receiptCategoryThreshold
    && canAutoOverwriteCategorySource(input.categorySource);
}

export function canAutoOverwriteCategorySource(source: CategorySource): boolean {
  return source === 'auto_rule'
    || source === 'plaid_signal'
    || source === 'ai_suggested'
    || source === 'uncategorized';
}

async function fallbackUncategorizedCategory() {
  return db.query.categories.findFirst({
    where: and(isNull(categories.businessId), eq(categories.name, 'Uncategorized')),
  });
}

async function latestReceiptMatchScore(receiptId: string, transactionId: string): Promise<number | null> {
  const [match] = await db
    .select({ score: receiptMatches.score })
    .from(receiptMatches)
    .where(and(eq(receiptMatches.receiptId, receiptId), eq(receiptMatches.transactionId, transactionId)))
    .orderBy(desc(receiptMatches.createdAt))
    .limit(1);
  return parseConfidence(match?.score);
}

function parseConfidence(value: unknown): number {
  if (value == null) return 0;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function receiptCategoryConfidence(ocrJson: Record<string, unknown>, fallback: number): number {
  const value = ocrJson.categoryConfidence ?? ocrJson.category_confidence;
  const confidence = parseConfidence(value);
  return confidence > 0 ? confidence : fallback;
}

function categoryNameFromReceiptJson(ocrJson: Record<string, unknown>): string | null {
  const value = ocrJson.categoryHint ?? ocrJson.category_hint ?? ocrJson.categoryName ?? ocrJson.category_name;
  return typeof value === 'string' && value.trim() ? value : null;
}

function receiptEvidenceText(receipt: Receipt, transaction: Transaction): string {
  const ocrJson = receipt.ocrJson ?? {};
  return [
    receipt.merchant,
    transaction.merchant,
    ocrJson.categoryHint,
    ocrJson.categoryEvidence,
    ocrJson.notes,
    JSON.stringify(ocrJson.lineItems ?? ocrJson.line_items ?? []),
    JSON.stringify(plaidCategoryHints(transaction.raw)),
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ');
}

function findPreferredCategoryByName(
  categoryRows: Category[],
  name: string,
  businessId: string,
): Category | null {
  const normalizedName = normalize(name);
  const matches = categoryRows.filter((category) => normalize(category.name) === normalizedName);
  return matches.find((category) => category.businessId === businessId)
    ?? matches.find((category) => category.businessId === null)
    ?? matches[0]
    ?? null;
}

function plaidCategoryHints(raw: Record<string, unknown>): string[] {
  const personalFinanceCategory = (
    raw.personal_finance_category && typeof raw.personal_finance_category === 'object'
      ? raw.personal_finance_category
      : {}
  ) as Record<string, unknown>;
  return [
    ...(Array.isArray(raw.category) ? raw.category : []),
    personalFinanceCategory.primary,
    personalFinanceCategory.detailed,
    personalFinanceCategory.confidence_level,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
}
