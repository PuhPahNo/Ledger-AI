import type { CategorizationReviewItem } from '@/types/domain';
import type { AutomationReviewType, LearnedRuleVia, ReviewGroup, ReviewGroupTransaction } from '@/types/automation';

/**
 * Display helpers for grouped categorization review (Home › Needs you) and the learned-rules
 * digest. Pure so they can be unit tested; the grouping itself happens on the server
 * (server/services/categorizationReviewGroups.ts) — `groupReviewItemsLocally` mirrors it for
 * mock mode only.
 */

/** Review items as they come over the wire; the server may send types the domain union lacks. */
export type AnyReviewItem = Omit<CategorizationReviewItem, 'type' | 'payload'> & {
  type: AutomationReviewType;
  payload: CategorizationReviewItem['payload'] & { normalizedMerchant?: string };
};

export type ReviewGroupKind = 'conflict' | 'external' | 'receipt' | 'learn' | 'ai' | 'other';

export const RULE_CONTRADICTION_KIND = 'learned_rule_contradiction';

export function isRuleContradiction(item: Pick<AnyReviewItem, 'type' | 'payload'>): boolean {
  return item.type === 'rule_conflict_review' && item.payload.evidence?.kind === RULE_CONTRADICTION_KIND;
}

/** The one kind a group is shown as — the most demanding type in it wins. */
export function reviewGroupKind(group: Pick<ReviewGroup, 'types'>): ReviewGroupKind {
  const types = new Set(group.types);
  if (types.has('rule_conflict_review')) return 'conflict';
  if (types.has('external_category_suggestion')) return 'external';
  if (types.has('receipt_category_override')) return 'receipt';
  if (types.has('learn_rule_prompt')) return 'learn';
  if (types.has('ai_category_suggestion')) return 'ai';
  return 'other';
}

/** "12 × Gusto → Wages" (the count is dropped for a single transaction). */
export function reviewGroupHeadline(group: Pick<ReviewGroup, 'merchant' | 'proposedCategoryName' | 'transactionCount' | 'itemCount'>): string {
  const count = group.transactionCount || group.itemCount;
  const target = group.proposedCategoryName ?? 'Uncategorized';
  return `${count > 1 ? `${count} × ` : ''}${group.merchant} → ${target}`;
}

function externalSourceName(item?: Pick<AnyReviewItem, 'payload' | 'title'>): string {
  const evidence = item?.payload.evidence;
  const source = typeof evidence?.signalSource === 'string'
    ? evidence.signalSource
    : typeof evidence?.source === 'string' ? evidence.source : null;
  if (!source || source === 'quickbooks') return 'QuickBooks';
  return `${source.charAt(0).toUpperCase()}${source.slice(1)}`;
}

function confidenceText(confidence: ReviewGroup['confidence']): string | null {
  if (!confidence) return null;
  const min = Math.round(confidence.min * 100);
  const max = Math.round(confidence.max * 100);
  return min === max ? `${max}% sure` : `${min}–${max}% sure`;
}

/**
 * The one-line "why" under a group's headline. `items` are the group's review items when
 * loaded (needed to name the current category for rule conflicts).
 */
export function reviewGroupReason(group: ReviewGroup, items: AnyReviewItem[] = []): string {
  const kind = reviewGroupKind(group);
  const first = items[0];
  const proposed = group.proposedCategoryName ?? 'another category';
  switch (kind) {
    case 'conflict': {
      const conflict = items.find(isRuleContradiction) ?? items.find((item) => item.type === 'rule_conflict_review');
      const ruleCategory = conflict?.payload.currentCategoryName;
      if (conflict && isRuleContradiction(conflict)) {
        return `You changed ${group.merchant} to ${proposed}, but a learned rule says ${ruleCategory ?? 'something else'}`;
      }
      return ruleCategory
        ? `A rule files ${group.merchant} under ${ruleCategory}; this suggests ${proposed}`
        : `Conflicts with an existing rule for ${group.merchant}`;
    }
    case 'external': {
      const external = items.find((item) => item.type === 'external_category_suggestion') ?? first;
      return `${externalSourceName(external)} says ${proposed}`;
    }
    case 'receipt':
      return `The receipt points to ${proposed}`;
    case 'learn':
      return `You've filed ${group.merchant} as ${proposed} before`;
    case 'ai': {
      const sure = confidenceText(group.confidence);
      return sure ? `AI suggestion · ${sure}` : 'AI suggestion';
    }
    default:
      return 'Needs a decision';
  }
}

/** Button words: conflicts are about the rule, everything else about the suggestion. */
export function reviewGroupActions(group: Pick<ReviewGroup, 'types' | 'itemCount'>): { accept: string; dismiss: string } {
  if (reviewGroupKind(group) === 'conflict') return { accept: 'Switch rule', dismiss: 'Keep rule' };
  return { accept: group.itemCount > 1 ? 'Accept all' : 'Accept', dismiss: 'Dismiss' };
}

/** Items of `group` that are loaded locally, in the group's order. */
export function itemsForGroup<T extends { id: string }>(group: Pick<ReviewGroup, 'itemIds'>, items: T[]): T[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return group.itemIds.map((id) => byId.get(id)).filter((item): item is T => Boolean(item));
}

export function learnedViaLabel(via: LearnedRuleVia): string {
  switch (via) {
    case 'consistent_corrections': return 'from your corrections';
    case 'learn_prompt_accepted': return 'you accepted a rule prompt';
    case 'review_group_accepted': return 'you accepted a review';
    case 'rule_conflict_accepted': return 'you switched a rule';
    default: return 'learned';
  }
}

/** "just now", "5m ago", "3h ago", "2d ago", then a short date. */
export function timeAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '—';
  const minutes = Math.round((now - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(then).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** "Last 7 days: 23 handled automatically · 2 rules learned" — parts with zero are left out. */
export function automationLineParts(summary: { handledAutomatically: number; rulesAutoLearned: number; rulesLearnedFromReview: number }): {
  handled: string | null;
  learned: string | null;
  learnedCount: number;
} {
  const learnedCount = summary.rulesAutoLearned + summary.rulesLearnedFromReview;
  return {
    handled: summary.handledAutomatically > 0 ? `${summary.handledAutomatically.toLocaleString('en-US')} handled automatically` : null,
    learned: learnedCount > 0 ? `${learnedCount} rule${learnedCount === 1 ? '' : 's'} learned` : null,
    learnedCount,
  };
}

// ---------------------------------------------------------------------------------------------
// Mock-mode grouping (mirrors groupReviewItems on the server)
// ---------------------------------------------------------------------------------------------

const SUGGESTION_TYPES = new Set<AutomationReviewType>(['ai_category_suggestion', 'external_category_suggestion']);
const RULE_LEARNING_TYPES = new Set<AutomationReviewType>(['learn_rule_prompt', 'ai_category_suggestion', 'external_category_suggestion', 'rule_conflict_review']);

function normalizeMerchant(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function groupReviewItemsLocally(items: AnyReviewItem[], transactionsById: Map<string, ReviewGroupTransaction>): ReviewGroup[] {
  const groups = new Map<string, ReviewGroup & { txnIds: Set<string> }>();
  for (const item of items) {
    const merchant = item.payload.merchant ?? item.payload.proposedRule?.pattern ?? item.title;
    const normalizedMerchant = item.payload.normalizedMerchant ?? item.payload.proposedRule?.pattern ?? normalizeMerchant(merchant);
    const proposedCategoryId = item.payload.proposedCategoryId ?? item.payload.proposedCategoryName ?? null;
    const key = `${item.businessId}|${normalizedMerchant}|${proposedCategoryId ?? ''}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        groupKey: key,
        businessId: item.businessId,
        biz: item.biz === 'all' ? null : item.biz,
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
        oldestCreatedAt: item.createdAt,
        newestCreatedAt: item.createdAt,
        txnIds: new Set(),
      };
      groups.set(key, group);
    }
    group.itemIds.push(item.id);
    group.itemCount += 1;
    if (!group.types.includes(item.type)) group.types.push(item.type);
    if (item.createdAt < group.oldestCreatedAt) group.oldestCreatedAt = item.createdAt;
    if (item.createdAt > group.newestCreatedAt) group.newestCreatedAt = item.createdAt;
    if (SUGGESTION_TYPES.has(item.type) && typeof item.payload.confidence === 'number') {
      const value = item.payload.confidence;
      group.confidence = group.confidence
        ? { min: Math.min(group.confidence.min, value), max: Math.max(group.confidence.max, value) }
        : { min: value, max: value };
    }
    for (const id of [...(item.payload.transactionIds ?? []), ...(item.payload.transactionId ? [item.payload.transactionId] : [])]) {
      group.txnIds.add(id);
    }
  }
  return [...groups.values()]
    .map(({ txnIds, ...group }) => {
      const rows = [...txnIds]
        .map((id) => transactionsById.get(id))
        .filter((row): row is ReviewGroupTransaction => Boolean(row))
        .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
      return {
        ...group,
        transactionCount: txnIds.size,
        totalCents: rows.reduce((sum, row) => sum + Math.abs(row.amountCents), 0),
        sampleTransactions: rows.slice(0, 3),
        learnsRule: Boolean(group.proposedCategoryId) && group.types.every((type) => RULE_LEARNING_TYPES.has(type)),
      };
    })
    .sort((a, b) => b.itemCount - a.itemCount || b.totalCents - a.totalCents || a.groupKey.localeCompare(b.groupKey));
}
