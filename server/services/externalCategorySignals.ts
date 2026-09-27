import { and, eq, like } from 'drizzle-orm';
import { db } from '../db/client.js';
import { categories, categorizationFeedback, categorizationReviewItems, transactions } from '../db/schema.js';
import { getAutomationSettings } from './appSettings.js';
import { categoryMatchesTransactionDirection, isProtectedCategorySource, normalize } from './categorization.js';
import {
  EXTERNAL_FEEDBACK_PREFIX,
  EXTERNAL_LEARNING_MIN_CONFIDENCE,
  evaluateMerchantLearning,
  isLearnableMerchant,
} from './categorizationLearning.js';
import { updateTransactionCategory, upsertReviewItem } from './categorizationReviewActions.js';

/**
 * Hook for category hints from outside systems (first user: QuickBooks account mappings).
 *
 *   await recordExternalCategorySignal({
 *     transactionId, categoryId, source: 'quickbooks', confidence: 0.97,
 *     evidence: { qbAccountId: '84', qbAccountName: 'Meals' },
 *   });
 *
 * - Confident (≥ the external-signal threshold, default 0.9) and the transaction's current
 *   category isn't human-set → applied as category_source 'external_signal'.
 * - Otherwise (low confidence, or it disagrees with a human-set category) → one
 *   'external_category_suggestion' review item per (source, transaction, category).
 * - Spend signals are also stored as feedback: they become AI prompt examples, and very
 *   confident ones (≥ 0.95) can corroborate a human correction streak toward auto-learning a
 *   rule. They never create a rule on their own and never open rule conflicts.
 */

export type ExternalSignalOutcome =
  | 'applied'
  | 'review'
  | 'unchanged'
  | 'invalid_transaction'
  | 'invalid_category';

export interface ExternalCategorySignalInput {
  transactionId: string;
  categoryId: string;
  /** Short lowercase label of the system, e.g. 'quickbooks'. Stored in evidence and feedback. */
  source: string;
  /** 0..1 — how sure the external system is. */
  confidence: number;
  evidence?: Record<string, unknown>;
}

export interface ExternalCategorySignalResult {
  outcome: ExternalSignalOutcome;
  reviewItemId?: string;
}

/** Pure decision, exported for tests. */
export function decideExternalSignal(input: {
  currentCategoryId: string | null;
  currentSource: string;
  proposedCategoryId: string;
  confidence: number;
  threshold: number;
}): 'apply' | 'review' | 'unchanged' {
  if (input.currentCategoryId === input.proposedCategoryId) return 'unchanged';
  if (isProtectedCategorySource(input.currentSource)) return 'review';
  return input.confidence >= input.threshold ? 'apply' : 'review';
}

export function normalizeSignalSource(source: string): string {
  return source.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 40) || 'external';
}

export async function recordExternalCategorySignal(input: ExternalCategorySignalInput): Promise<ExternalCategorySignalResult> {
  const source = normalizeSignalSource(input.source);
  const confidence = Math.max(0, Math.min(1, Number.isFinite(input.confidence) ? input.confidence : 0));
  const [transaction, category] = await Promise.all([
    db.query.transactions.findFirst({ where: eq(transactions.id, input.transactionId) }),
    db.query.categories.findFirst({ where: eq(categories.id, input.categoryId) }),
  ]);
  if (!transaction) return { outcome: 'invalid_transaction' };
  if (
    !category
    || !category.active
    || (category.businessId && category.businessId !== transaction.businessId)
    || !categoryMatchesTransactionDirection(category, transaction.amountCents)
  ) {
    return { outcome: 'invalid_category' };
  }

  const evidence = {
    signalSource: source,
    externalConfidence: confidence,
    ...(input.evidence ?? {}),
  };
  const { externalSignalAutoApplyConfidence } = await getAutomationSettings();
  const decision = decideExternalSignal({
    currentCategoryId: transaction.categoryId,
    currentSource: transaction.categorySource,
    proposedCategoryId: category.id,
    confidence,
    threshold: externalSignalAutoApplyConfidence,
  });

  // Learning evidence is recorded after the write so a rule learned from it relabels the
  // row as a trusted rule hit rather than being overwritten by the signal.
  const learn = () => recordExternalFeedback({ transaction, categoryId: category.id, source, confidence, evidence });
  if (decision === 'unchanged') {
    await expireOpenSignalReviews(source, transaction.id);
    await learn();
    return { outcome: 'unchanged' };
  }
  if (decision === 'apply') {
    await updateTransactionCategory({
      transaction,
      newCategoryId: category.id,
      source: 'external_signal',
      confidence,
      evidence,
    });
    await expireOpenSignalReviews(source, transaction.id);
    await learn();
    return { outcome: 'applied' };
  }

  const currentCategory = transaction.categoryId
    ? await db.query.categories.findFirst({ where: eq(categories.id, transaction.categoryId) })
    : null;
  const label = sourceDisplayName(source);
  const item = await upsertReviewItem({
    businessId: transaction.businessId,
    type: 'external_category_suggestion',
    fingerprint: `external:${source}:${transaction.id}:${category.id}`,
    title: `${label} suggests ${category.name}`,
    detail: isProtectedCategorySource(transaction.categorySource)
      ? `${label} files this ${transaction.merchant} transaction under ${category.name}, but it is set to ${currentCategory?.name ?? 'another category'}.`
      : `${label} suggests ${category.name} for ${transaction.merchant}.`,
    payload: {
      transactionId: transaction.id,
      transactionIds: [transaction.id],
      merchant: transaction.merchant,
      normalizedMerchant: normalize(transaction.merchant),
      currentCategoryId: transaction.categoryId,
      currentCategoryName: currentCategory?.name ?? null,
      proposedCategoryId: category.id,
      proposedCategoryName: category.name,
      confidence,
      evidence,
    },
  });
  await learn();
  return { outcome: 'review', reviewItemId: item.id };
}

/** A signal that now applies (or already matches) makes its earlier open review items moot. */
async function expireOpenSignalReviews(source: string, transactionId: string): Promise<void> {
  await db.update(categorizationReviewItems)
    .set({ status: 'expired', resolvedAction: 'superseded_by_signal', resolvedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(categorizationReviewItems.type, 'external_category_suggestion'),
      eq(categorizationReviewItems.status, 'open'),
      like(categorizationReviewItems.fingerprint, `external:${source}:${transactionId}:%`),
    ));
}

function sourceDisplayName(source: string): string {
  if (source === 'quickbooks') return 'QuickBooks';
  return source.charAt(0).toUpperCase() + source.slice(1);
}

async function recordExternalFeedback(input: {
  transaction: typeof transactions.$inferSelect;
  categoryId: string;
  source: string;
  confidence: number;
  evidence: Record<string, unknown>;
}): Promise<void> {
  if (input.transaction.amountCents >= 0) return;
  const normalizedMerchant = normalize(input.transaction.merchant);
  if (!isLearnableMerchant(normalizedMerchant)) return;
  // Syncs resend the same mapping; one feedback row per (transaction, category, source).
  const [already] = await db
    .select({ id: categorizationFeedback.id })
    .from(categorizationFeedback)
    .where(and(
      eq(categorizationFeedback.transactionId, input.transaction.id),
      eq(categorizationFeedback.newCategoryId, input.categoryId),
      eq(categorizationFeedback.source, `${EXTERNAL_FEEDBACK_PREFIX}${input.source}`),
    ))
    .limit(1);
  if (already) return;
  await db.insert(categorizationFeedback).values({
    businessId: input.transaction.businessId,
    transactionId: input.transaction.id,
    merchant: input.transaction.merchant,
    normalizedMerchant,
    previousCategoryId: input.transaction.categoryId,
    newCategoryId: input.categoryId,
    source: `${EXTERNAL_FEEDBACK_PREFIX}${input.source}`,
    payload: { confidence: input.confidence, evidence: input.evidence },
  });
  if (input.confidence >= EXTERNAL_LEARNING_MIN_CONFIDENCE) {
    await evaluateMerchantLearning({
      businessId: input.transaction.businessId,
      merchant: input.transaction.merchant,
      categoryId: input.categoryId,
      transactionIds: [input.transaction.id],
      human: false,
    });
  }
}
