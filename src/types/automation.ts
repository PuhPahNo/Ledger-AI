// Types for the categorization automation endpoints (learning loop, grouped review,
// "handled automatically" stats). Mirrors server/services/categorizationLearning.ts,
// categorizationReviewGroups.ts and automationStats.ts.

import type { BusinessId, CategorizationReviewType } from './domain';

/** Category sources beyond the base domain union (external systems such as QuickBooks). */
export type AutomationCategorySource = 'external_signal';

/** Review item types added by the automation work. */
export type AutomationReviewType = CategorizationReviewType | 'external_category_suggestion';

export type LearnedRuleVia =
  | 'consistent_corrections'
  | 'learn_prompt_accepted'
  | 'review_group_accepted'
  | 'rule_conflict_accepted';

export interface AutomationSummary {
  period: { from: string; to: string; days: number };
  /** Distinct transactions categorized with no person involved in the period. */
  handledAutomatically: number;
  autoCategorized: {
    total: number;
    bySource: { rule: number; ai: number; plaidSignal: number; receiptEvidence: number; external: number };
  };
  rulesAutoLearned: number;
  rulesLearnedFromReview: number;
  aiSuggestionsApplied: { automatic: number; acceptedByYou: number };
  /** Open review work right now — `groups` is the number of decisions. */
  needsReview: { items: number; groups: number };
}

export interface ReviewGroupTransaction {
  id: string;
  date: string;
  merchant: string;
  amountCents: number;
  categoryId: string | null;
  categoryName: string | null;
}

export interface ReviewGroup {
  /** Opaque; send back to accept/dismiss. */
  groupKey: string;
  businessId: string;
  biz: BusinessId | null;
  merchant: string;
  normalizedMerchant: string;
  proposedCategoryId: string | null;
  proposedCategoryName: string | null;
  types: AutomationReviewType[];
  itemIds: string[];
  itemCount: number;
  transactionCount: number;
  totalCents: number;
  confidence: { min: number; max: number } | null;
  sampleTransactions: ReviewGroupTransaction[];
  /** Accepting also creates a trusted merchant rule so future ones auto-apply. */
  learnsRule: boolean;
  oldestCreatedAt: string;
  newestCreatedAt: string;
}

export interface ResolveReviewGroupResult {
  groupKey: string;
  action: 'accept' | 'dismiss';
  resolvedCount: number;
  appliedCount: number;
  conflictCount: number;
  learnedRuleId: string | null;
  relabelledCount: number;
}

export interface LearnedRule {
  id: string;
  businessId: string;
  biz: BusinessId | null;
  businessName: string | null;
  merchant: string;
  normalizedMerchant: string;
  categoryId: string;
  categoryName: string | null;
  previousCategoryId: string | null;
  previousCategoryName: string | null;
  learnedVia: LearnedRuleVia;
  ruleId: string | null;
  ruleActive: boolean;
  relabelledCount: number;
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

export interface UndoLearnedRuleResult {
  id: string;
  alreadyUndone: boolean;
  ruleAction: 'delete' | 'restore' | 'leave';
  restoredCount: number;
  skippedCount: number;
  undoneAt: string | null;
}

export interface AutomationSettings {
  autoLearnMinCorrections: number;
  externalSignalAutoApplyConfidence: number;
  limits: {
    autoLearnMinCorrections: { min: number; max: number };
    externalSignalAutoApplyConfidence: { min: number; max: number };
  };
}
