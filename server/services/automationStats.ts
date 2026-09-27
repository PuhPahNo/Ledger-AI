import { and, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  businesses,
  categorizationLearnedRules,
  categorizationReviewItems,
  transactionCategoryEvents,
  transactions,
} from '../db/schema.js';
import { countOpenReviewGroups } from './categorizationReviewGroups.js';

/**
 * "23 handled automatically, 4 need you" — what the categorization automation did over a
 * period, for the Home summary line.
 */

export type AutomationBucket = 'rule' | 'ai' | 'plaidSignal' | 'receiptEvidence' | 'external';

export const AUTOMATED_SOURCE_BUCKETS: Record<string, AutomationBucket> = {
  auto_rule: 'rule',
  user_confirmed_rule: 'rule',
  ai_suggested: 'ai',
  plaid_signal: 'plaidSignal',
  receipt_evidence: 'receiptEvidence',
  external_signal: 'external',
};
const AUTOMATED_SOURCES = Object.keys(AUTOMATED_SOURCE_BUCKETS);

export interface AutomationSummary {
  period: { from: string; to: string; days: number };
  /** Distinct transactions the system categorized without a person in the period. */
  handledAutomatically: number;
  autoCategorized: { total: number; bySource: Record<AutomationBucket, number> };
  rulesAutoLearned: number;
  rulesLearnedFromReview: number;
  aiSuggestionsApplied: { automatic: number; acceptedByYou: number };
  needsReview: { items: number; groups: number };
}

/**
 * Pure merge: new arrivals keyed by their current source, then later automated
 * re-categorizations (latest event wins). Each transaction counts once.
 */
export function tallyAutomatedTransactions(
  arrivals: Array<{ id: string; source: string }>,
  events: Array<{ transactionId: string; source: string }>,
): { total: number; bySource: Record<AutomationBucket, number> } {
  const byTransaction = new Map<string, AutomationBucket>();
  for (const row of arrivals) {
    const bucket = AUTOMATED_SOURCE_BUCKETS[row.source];
    if (bucket) byTransaction.set(row.id, bucket);
  }
  for (const row of events) {
    const bucket = AUTOMATED_SOURCE_BUCKETS[row.source];
    if (bucket) byTransaction.set(row.transactionId, bucket);
  }
  const bySource: Record<AutomationBucket, number> = { rule: 0, ai: 0, plaidSignal: 0, receiptEvidence: 0, external: 0 };
  for (const bucket of byTransaction.values()) bySource[bucket] += 1;
  return { total: byTransaction.size, bySource };
}

export async function getAutomationSummary(input: {
  days?: number;
  businessKey?: string;
  now?: Date;
} = {}): Promise<AutomationSummary> {
  const days = input.days ?? 7;
  const to = input.now ?? new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const business = input.businessKey && input.businessKey !== 'all'
    ? await db.query.businesses.findFirst({ where: eq(businesses.key, input.businessKey) })
    : null;
  const businessId = business?.id ?? null;
  if (input.businessKey && input.businessKey !== 'all' && !business) {
    return emptySummary(from, to, days);
  }

  const [arrivals, eventRows, learned, acceptedAi, review] = await Promise.all([
    // New transactions whose category is still the machine's (a later human edit removes them).
    db
      .select({ id: transactions.id, source: transactions.categorySource })
      .from(transactions)
      .where(and(
        gte(transactions.createdAt, from),
        lt(transactions.createdAt, to),
        inArray(transactions.categorySource, AUTOMATED_SOURCES as Array<typeof transactions.$inferSelect['categorySource']>),
        businessId ? eq(transactions.businessId, businessId) : sql`true`,
      )),
    // Re-categorizations with no person behind them (nightly scan, receipt evidence) plus
    // history a learned rule relabelled. Skip rows a human has since set by hand.
    db
      .selectDistinctOn([transactionCategoryEvents.transactionId], {
        transactionId: transactionCategoryEvents.transactionId,
        source: transactionCategoryEvents.source,
      })
      .from(transactionCategoryEvents)
      .innerJoin(transactions, eq(transactionCategoryEvents.transactionId, transactions.id))
      .where(and(
        gte(transactionCategoryEvents.createdAt, from),
        lt(transactionCategoryEvents.createdAt, to),
        inArray(transactionCategoryEvents.source, AUTOMATED_SOURCES as Array<typeof transactions.$inferSelect['categorySource']>),
        sql`(${transactionCategoryEvents.createdByUserId} IS NULL OR ${transactionCategoryEvents.evidence} ? 'learningEventId')`,
        sql`${transactions.categorySource} <> 'manual'`,
        businessId ? eq(transactionCategoryEvents.businessId, businessId) : sql`true`,
      ))
      .orderBy(transactionCategoryEvents.transactionId, desc(transactionCategoryEvents.createdAt)),
    db
      .select({
        auto: sql<number>`count(*) FILTER (WHERE ${categorizationLearnedRules.learnedVia} = 'consistent_corrections')::int`,
        review: sql<number>`count(*) FILTER (WHERE ${categorizationLearnedRules.learnedVia} <> 'consistent_corrections')::int`,
      })
      .from(categorizationLearnedRules)
      .where(and(
        gte(categorizationLearnedRules.createdAt, from),
        lt(categorizationLearnedRules.createdAt, to),
        isNull(categorizationLearnedRules.undoneAt),
        businessId ? eq(categorizationLearnedRules.businessId, businessId) : sql`true`,
      )),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(categorizationReviewItems)
      .where(and(
        eq(categorizationReviewItems.type, 'ai_category_suggestion'),
        eq(categorizationReviewItems.status, 'accepted'),
        gte(categorizationReviewItems.resolvedAt, from),
        lt(categorizationReviewItems.resolvedAt, to),
        businessId ? eq(categorizationReviewItems.businessId, businessId) : sql`true`,
      )),
    countOpenReviewGroups({ businessKey: input.businessKey }),
  ]);

  const autoCategorized = tallyAutomatedTransactions(arrivals, eventRows);
  return {
    period: { from: from.toISOString(), to: to.toISOString(), days },
    handledAutomatically: autoCategorized.total,
    autoCategorized,
    rulesAutoLearned: Number(learned[0]?.auto ?? 0),
    rulesLearnedFromReview: Number(learned[0]?.review ?? 0),
    aiSuggestionsApplied: {
      automatic: autoCategorized.bySource.ai,
      acceptedByYou: Number(acceptedAi[0]?.count ?? 0),
    },
    needsReview: review,
  };
}

function emptySummary(from: Date, to: Date, days: number): AutomationSummary {
  return {
    period: { from: from.toISOString(), to: to.toISOString(), days },
    handledAutomatically: 0,
    autoCategorized: { total: 0, bySource: { rule: 0, ai: 0, plaidSignal: 0, receiptEvidence: 0, external: 0 } },
    rulesAutoLearned: 0,
    rulesLearnedFromReview: 0,
    aiSuggestionsApplied: { automatic: 0, acceptedByYou: 0 },
    needsReview: { items: 0, groups: 0 },
  };
}
