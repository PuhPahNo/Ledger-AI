import type { BusinessId } from '@/types/domain';
import type {
  AutomationSettings,
  AutomationSummary,
  LearnedRule,
  ResolveReviewGroupResult,
  ReviewGroup,
  UndoLearnedRuleResult,
} from '@/types/automation';
import { http, useMockApi } from './client';

// ---------------------------------------------------------------------------
// Mock fixtures (used when VITE_USE_MOCK_API is on; also handy for stories/tests)
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY_MS).toISOString();
const isoDate = (daysAgo: number) => iso(daysAgo).slice(0, 10);

export const MOCK_AUTOMATION_SUMMARY: AutomationSummary = {
  period: { from: iso(7), to: iso(0), days: 7 },
  handledAutomatically: 23,
  autoCategorized: {
    total: 23,
    bySource: { rule: 14, ai: 5, plaidSignal: 3, receiptEvidence: 1, external: 0 },
  },
  rulesAutoLearned: 2,
  rulesLearnedFromReview: 1,
  aiSuggestionsApplied: { automatic: 5, acceptedByYou: 3 },
  needsReview: { items: 9, groups: 4 },
};

export const MOCK_REVIEW_GROUPS: ReviewGroup[] = [
  {
    groupKey: 'mock-biz|uber|mock-category-travel',
    businessId: 'mock-biz',
    biz: 'draft-sharks',
    merchant: 'Uber',
    normalizedMerchant: 'uber',
    proposedCategoryId: 'mock-category-travel',
    proposedCategoryName: 'Travel',
    types: ['ai_category_suggestion'],
    itemIds: ['mock-review-1', 'mock-review-2', 'mock-review-3', 'mock-review-4', 'mock-review-5'],
    itemCount: 5,
    transactionCount: 5,
    totalCents: 14230,
    confidence: { min: 0.62, max: 0.81 },
    sampleTransactions: [
      { id: 'mock-txn-u1', date: isoDate(1), merchant: 'UBER *TRIP', amountCents: -2810, categoryId: null, categoryName: 'Uncategorized' },
      { id: 'mock-txn-u2', date: isoDate(3), merchant: 'UBER *TRIP', amountCents: -3125, categoryId: null, categoryName: 'Uncategorized' },
      { id: 'mock-txn-u3', date: isoDate(6), merchant: 'Uber', amountCents: -1990, categoryId: null, categoryName: 'Uncategorized' },
    ],
    learnsRule: true,
    oldestCreatedAt: iso(6),
    newestCreatedAt: iso(1),
  },
  {
    groupKey: 'mock-biz|figma|mock-category-software',
    businessId: 'mock-biz',
    biz: 'draft-sharks',
    merchant: 'Figma',
    normalizedMerchant: 'figma',
    proposedCategoryId: 'mock-category-software',
    proposedCategoryName: 'Software',
    types: ['external_category_suggestion'],
    itemIds: ['mock-review-6'],
    itemCount: 1,
    transactionCount: 1,
    totalCents: 4500,
    confidence: { min: 0.8, max: 0.8 },
    sampleTransactions: [
      { id: 'mock-txn-f1', date: isoDate(2), merchant: 'FIGMA', amountCents: -4500, categoryId: 'mock-category-office', categoryName: 'Office' },
    ],
    learnsRule: true,
    oldestCreatedAt: iso(2),
    newestCreatedAt: iso(2),
  },
];

export const MOCK_LEARNED_RULES: LearnedRule[] = [
  {
    id: 'mock-learned-1',
    businessId: 'mock-biz',
    biz: 'draft-sharks',
    businessName: 'Draft Sharks',
    merchant: 'Blue Bottle',
    normalizedMerchant: 'blue bottle',
    categoryId: 'mock-category-meals',
    categoryName: 'Meals',
    previousCategoryId: null,
    previousCategoryName: null,
    learnedVia: 'consistent_corrections',
    ruleId: 'mock-rule-bb',
    ruleActive: true,
    relabelledCount: 7,
    restorableCount: 7,
    skippedProtectedCount: 0,
    correctionCount: 2,
    corrections: [
      { transactionId: 'mock-txn-b1', date: isoDate(2), merchant: 'SQ *BLUE BOTTLE', amountCents: -650 },
      { transactionId: 'mock-txn-b2', date: isoDate(4), merchant: 'Blue Bottle', amountCents: -720 },
    ],
    learnedByUserId: 'mock-user',
    learnedByName: 'Anthony',
    createdAt: iso(1),
    undoneAt: null,
    undoneByName: null,
    undoRestoredCount: null,
  },
];

export const MOCK_AUTOMATION_SETTINGS: AutomationSettings = {
  autoLearnMinCorrections: 2,
  externalSignalAutoApplyConfidence: 0.9,
  limits: {
    autoLearnMinCorrections: { min: 1, max: 10 },
    externalSignalAutoApplyConfidence: { min: 0.5, max: 1 },
  },
};

// ---------------------------------------------------------------------------
// Client functions
// ---------------------------------------------------------------------------

function bizQuery(query: URLSearchParams, biz?: BusinessId | 'all'): void {
  if (biz && biz !== 'all') query.set('biz', biz);
}

/** GET /api/automation/summary — "N handled automatically, M need you" for the Home line. */
export function getAutomationSummary(params: { biz?: BusinessId | 'all'; days?: number } = {}): Promise<AutomationSummary> {
  if (useMockApi) return Promise.resolve(MOCK_AUTOMATION_SUMMARY);
  const query = new URLSearchParams();
  bizQuery(query, params.biz);
  if (params.days) query.set('days', String(params.days));
  const qs = query.toString();
  return http<AutomationSummary>(`/automation/summary${qs ? `?${qs}` : ''}`);
}

/** GET /api/categorization/review-groups — open review items grouped per decision. */
export function listReviewGroups(params: { biz?: BusinessId | 'all' } = {}): Promise<ReviewGroup[]> {
  if (useMockApi) {
    return Promise.resolve(MOCK_REVIEW_GROUPS.filter((group) => !params.biz || params.biz === 'all' || group.biz === params.biz));
  }
  const query = new URLSearchParams();
  bizQuery(query, params.biz);
  const qs = query.toString();
  return http<ReviewGroup[]>(`/categorization/review-groups${qs ? `?${qs}` : ''}`);
}

/**
 * POST /api/categorization/review-groups/{accept|dismiss}. Pass the group's itemIds so
 * items that arrived after the user looked stay open.
 */
export function resolveReviewGroup(
  group: Pick<ReviewGroup, 'groupKey' | 'itemIds'>,
  action: 'accept' | 'dismiss',
): Promise<ResolveReviewGroupResult> {
  if (useMockApi) {
    return Promise.resolve({
      groupKey: group.groupKey,
      action,
      resolvedCount: group.itemIds.length,
      appliedCount: action === 'accept' ? group.itemIds.length : 0,
      conflictCount: 0,
      learnedRuleId: action === 'accept' ? 'mock-learned-new' : null,
      relabelledCount: 0,
    });
  }
  return http<ResolveReviewGroupResult>(`/categorization/review-groups/${action}`, {
    method: 'POST',
    body: JSON.stringify({ groupKey: group.groupKey, itemIds: group.itemIds }),
  });
}

export const acceptReviewGroup = (group: Pick<ReviewGroup, 'groupKey' | 'itemIds'>) => resolveReviewGroup(group, 'accept');
export const dismissReviewGroup = (group: Pick<ReviewGroup, 'groupKey' | 'itemIds'>) => resolveReviewGroup(group, 'dismiss');

/** GET /api/categorization/learned-rules — digest of rules learned in the last N days. */
export function listLearnedRules(params: {
  biz?: BusinessId | 'all';
  days?: number;
  includeUndone?: boolean;
  /** 'auto' (default): only rules learned from consistent corrections. */
  via?: 'auto' | 'all';
} = {}): Promise<LearnedRule[]> {
  if (useMockApi) return Promise.resolve(MOCK_LEARNED_RULES);
  const query = new URLSearchParams();
  bizQuery(query, params.biz);
  if (params.days) query.set('days', String(params.days));
  if (params.includeUndone) query.set('includeUndone', 'true');
  if (params.via) query.set('via', params.via);
  const qs = query.toString();
  return http<LearnedRule[]>(`/categorization/learned-rules${qs ? `?${qs}` : ''}`);
}

/** POST /api/categorization/learned-rules/:id/undo — removes the rule, restores relabelled rows. */
export function undoLearnedRule(id: string): Promise<UndoLearnedRuleResult> {
  if (useMockApi) {
    const rule = MOCK_LEARNED_RULES.find((row) => row.id === id);
    return Promise.resolve({
      id,
      alreadyUndone: false,
      ruleAction: rule?.previousCategoryId ? 'restore' : 'delete',
      restoredCount: rule?.restorableCount ?? 0,
      skippedCount: 0,
      undoneAt: new Date().toISOString(),
    });
  }
  return http<UndoLearnedRuleResult>(`/categorization/learned-rules/${id}/undo`, { method: 'POST' });
}

export function getAutomationSettings(): Promise<AutomationSettings> {
  if (useMockApi) return Promise.resolve(MOCK_AUTOMATION_SETTINGS);
  return http<AutomationSettings>('/categorization/automation-settings');
}

export function updateAutomationSettings(
  body: Partial<Pick<AutomationSettings, 'autoLearnMinCorrections' | 'externalSignalAutoApplyConfidence'>>,
): Promise<AutomationSettings> {
  if (useMockApi) return Promise.resolve({ ...MOCK_AUTOMATION_SETTINGS, ...body });
  return http<AutomationSettings>('/categorization/automation-settings', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}
