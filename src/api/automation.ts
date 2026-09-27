import type { BusinessId } from '@/types/domain';
import type {
  AutomationSettings,
  AutomationSummary,
  LearnedRule,
  ResolveReviewGroupResult,
  ReviewGroup,
  ReviewGroupTransaction,
  UndoLearnedRuleResult,
} from '@/types/automation';
import { groupReviewItemsLocally, type AnyReviewItem } from '@/lib/reviewGroups';
import { http, useMockApi } from './client';
import { listCategorizationReviewItems, resolveCategorizationReviewItem } from './categorizationReview';
import { MOCK_REVIEW_ITEMS, TRANSACTIONS } from './mocks';

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
  rulesAutoLearned: 1,
  rulesLearnedFromReview: 1,
  aiSuggestionsApplied: { automatic: 5, acceptedByYou: 3 },
  needsReview: { items: 17, groups: 5 },
};

// Open review items behind the grouped Needs-you rows (mock mode). Grouped client-side the same
// way the server groups them, so resolving a group or a single item updates both views.
const reviewItem = (item: {
  id: string;
  biz: BusinessId;
  type: AnyReviewItem['type'];
  title: string;
  detail: string;
  daysAgo: number;
  payload: AnyReviewItem['payload'];
}): AnyReviewItem => ({
  id: item.id,
  businessId: `mock-${item.biz}`,
  biz: item.biz,
  type: item.type,
  status: 'open',
  title: item.title,
  detail: item.detail,
  payload: item.payload,
  createdAt: iso(item.daysAgo),
  updatedAt: iso(item.daysAgo),
});

const GUSTO_AMOUNTS = [41250, 35890, 29800, 38000, 33120, 31500, 36075, 30990, 34210, 37480, 36205, 36480];

/** Review-only transactions the fixtures point at (the rest resolve against mocks.TRANSACTIONS). */
const MOCK_REVIEW_TRANSACTIONS: ReviewGroupTransaction[] = [
  ...GUSTO_AMOUNTS.map((amountCents, index) => ({
    id: `mock-txn-gusto-${index + 1}`,
    date: isoDate(2 + index * 7),
    merchant: index % 2 ? 'GUSTO PAYROLL' : 'Gusto',
    amountCents: -amountCents,
    categoryId: null,
    categoryName: null,
  })),
  { id: 'mock-txn-jane-1', date: isoDate(4), merchant: 'ACH JANE DOE DESIGN', amountCents: -90000, categoryId: 'mock-category-professional', categoryName: 'Professional Services' },
  { id: 'mock-txn-jane-2', date: isoDate(26), merchant: 'ACH JANE DOE DESIGN', amountCents: -45000, categoryId: 'mock-category-professional', categoryName: 'Professional Services' },
];

export const MOCK_AUTOMATION_REVIEW_ITEMS: AnyReviewItem[] = [
  ...GUSTO_AMOUNTS.map((_, index) => reviewItem({
    id: `mock-review-gusto-${index + 1}`,
    biz: 'draft-sharks',
    type: 'ai_category_suggestion',
    title: 'Gusto looks like Wages',
    detail: 'Payroll provider debit; payroll runs are usually Wages.',
    daysAgo: 2 + index * 7,
    payload: {
      merchant: 'Gusto',
      normalizedMerchant: 'gusto',
      transactionId: `mock-txn-gusto-${index + 1}`,
      transactionIds: [`mock-txn-gusto-${index + 1}`],
      proposedCategoryId: 'mock-category-wages',
      proposedCategoryName: 'Wages',
      confidence: 0.74 + (index % 4) * 0.04,
    },
  })),
  reviewItem({
    id: 'mock-review-adobe-conflict',
    biz: 'draft-sharks',
    type: 'rule_conflict_review',
    title: 'Update the Adobe rule?',
    detail: 'Your rule files Adobe under Office Expense, but you set Software. Accept to switch the rule; dismiss to keep it.',
    daysAgo: 1,
    payload: {
      merchant: 'Adobe',
      normalizedMerchant: 'adobe',
      transactionId: 't11',
      transactionIds: ['t11'],
      currentCategoryId: 'mock-category-office',
      currentCategoryName: 'Office Expense',
      proposedCategoryId: 'mock-category-software',
      proposedCategoryName: 'Software',
      confidence: 1,
      evidence: { kind: 'learned_rule_contradiction', ruleId: 'mock-rule-adobe' },
    },
  }),
  ...['mock-txn-jane-1', 'mock-txn-jane-2'].map((transactionId, index) => reviewItem({
    id: `mock-review-jane-${index + 1}`,
    biz: 'draft-sharks',
    type: 'external_category_suggestion',
    title: 'QuickBooks suggests Contract Labor',
    detail: 'QuickBooks files this Jane Doe Design transaction under Contract Labor, but it is set to Professional Services.',
    daysAgo: 3 + index * 20,
    payload: {
      merchant: 'Jane Doe Design',
      normalizedMerchant: 'jane doe design',
      transactionId,
      transactionIds: [transactionId],
      currentCategoryId: 'mock-category-professional',
      currentCategoryName: 'Professional Services',
      proposedCategoryId: 'mock-category-contract',
      proposedCategoryName: 'Contract Labor',
      confidence: 0.77,
      evidence: { signalSource: 'quickbooks', qbAccountName: 'Contract Labor' },
    },
  })),
];

function mockReviewTransactions(): Map<string, ReviewGroupTransaction> {
  const map = new Map<string, ReviewGroupTransaction>();
  for (const txn of TRANSACTIONS) {
    map.set(txn.id, {
      id: txn.id,
      date: txn.date,
      merchant: txn.merchant,
      amountCents: Math.round(txn.amount * 100),
      categoryId: null,
      categoryName: txn.cat,
    });
  }
  for (const txn of MOCK_REVIEW_TRANSACTIONS) map.set(txn.id, txn);
  return map;
}

function allMockReviewItems(): AnyReviewItem[] {
  return [...(MOCK_REVIEW_ITEMS as AnyReviewItem[]), ...MOCK_AUTOMATION_REVIEW_ITEMS];
}

function removeMockReviewItems(ids: string[]): void {
  for (const list of [MOCK_REVIEW_ITEMS as AnyReviewItem[], MOCK_AUTOMATION_REVIEW_ITEMS]) {
    for (let index = list.length - 1; index >= 0; index -= 1) {
      if (ids.includes(list[index].id)) list.splice(index, 1);
    }
  }
}

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
  {
    id: 'mock-learned-2',
    businessId: 'mock-pointsnav',
    biz: 'pointsnav',
    businessName: 'PointsNav',
    merchant: 'Lyft',
    normalizedMerchant: 'lyft',
    categoryId: 'mock-category-travel',
    categoryName: 'Travel',
    previousCategoryId: null,
    previousCategoryName: null,
    learnedVia: 'review_group_accepted',
    ruleId: 'mock-rule-lyft',
    ruleActive: true,
    relabelledCount: 4,
    restorableCount: 4,
    skippedProtectedCount: 1,
    correctionCount: 0,
    corrections: [],
    learnedByUserId: 'mock-user',
    learnedByName: 'Anthony',
    createdAt: iso(3),
    undoneAt: null,
    undoneByName: null,
    undoRestoredCount: null,
  },
  {
    id: 'mock-learned-3',
    businessId: 'mock-biz',
    biz: 'draft-sharks',
    businessName: 'Draft Sharks',
    merchant: 'Amazon',
    normalizedMerchant: 'amazon',
    categoryId: 'mock-category-office',
    categoryName: 'Office Supplies',
    previousCategoryId: null,
    previousCategoryName: null,
    learnedVia: 'consistent_corrections',
    ruleId: null,
    ruleActive: false,
    relabelledCount: 9,
    restorableCount: 0,
    skippedProtectedCount: 0,
    correctionCount: 3,
    corrections: [],
    learnedByUserId: 'mock-user',
    learnedByName: 'Anthony',
    createdAt: iso(10),
    undoneAt: iso(9),
    undoneByName: 'Anthony',
    undoRestoredCount: 8,
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
    const items = allMockReviewItems().filter((item) => !params.biz || params.biz === 'all' || item.biz === params.biz);
    return Promise.resolve(groupReviewItemsLocally(items, mockReviewTransactions()));
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
    removeMockReviewItems(group.itemIds);
    return Promise.resolve({
      groupKey: group.groupKey,
      action,
      resolvedCount: group.itemIds.length,
      appliedCount: action === 'accept' ? group.itemIds.length : 0,
      conflictCount: 0,
      learnedRuleId: null,
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
  if (useMockApi) {
    const since = Date.now() - (params.days ?? 14) * DAY_MS;
    return Promise.resolve(structuredClone(MOCK_LEARNED_RULES.filter((rule) => (
      Date.parse(rule.createdAt) >= since
      && (params.includeUndone || !rule.undoneAt)
      && (params.via === 'all' || rule.learnedVia === 'consistent_corrections')
      && (!params.biz || params.biz === 'all' || rule.biz === params.biz)
    ))));
  }
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
    const alreadyUndone = Boolean(rule?.undoneAt);
    const restoredCount = alreadyUndone ? 0 : rule?.restorableCount ?? 0;
    const skippedCount = alreadyUndone ? 0 : rule?.skippedProtectedCount ?? 0;
    if (rule && !alreadyUndone) {
      Object.assign(rule, {
        undoneAt: new Date().toISOString(),
        undoneByName: 'You',
        undoRestoredCount: restoredCount,
        ruleActive: false,
        restorableCount: 0,
      });
    }
    return Promise.resolve({
      id,
      alreadyUndone,
      ruleAction: rule?.previousCategoryId ? 'restore' : 'delete',
      restoredCount,
      skippedCount,
      undoneAt: rule?.undoneAt ?? new Date().toISOString(),
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
  if (useMockApi) return Promise.resolve(Object.assign(MOCK_AUTOMATION_SETTINGS, body));
  return http<AutomationSettings>('/categorization/automation-settings', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

/**
 * Open review items, individually — the detail behind each grouped row (the server's list is
 * capped at 100, so a large group may only have some of its items here).
 */
export function listOpenReviewItems(params: { biz?: BusinessId | 'all' } = {}): Promise<AnyReviewItem[]> {
  if (useMockApi) {
    return Promise.resolve(allMockReviewItems().filter((item) => !params.biz || params.biz === 'all' || item.biz === params.biz));
  }
  return listCategorizationReviewItems(params) as Promise<AnyReviewItem[]>;
}

/** Accept / dismiss one item from inside a group. */
export async function resolveReviewItem(id: string, action: 'accept' | 'dismiss'): Promise<{ appliedCount: number; conflictCount: number }> {
  if (useMockApi) {
    removeMockReviewItems([id]);
    return { appliedCount: action === 'accept' ? 1 : 0, conflictCount: 0 };
  }
  const result = await resolveCategorizationReviewItem(id, action);
  return { appliedCount: result.appliedCount, conflictCount: result.conflictCount };
}
