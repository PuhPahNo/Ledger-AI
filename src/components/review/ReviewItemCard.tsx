import { Check, X } from 'lucide-react';
import type { Business, CategorizationReviewItem } from '@/types/domain';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

/**
 * One categorization review item (learn-rule prompt, AI suggestion, receipt evidence,
 * rule conflict) with accept/dismiss. Shared by the notifications modal and the Inbox page.
 */
export function ReviewItemCard({
  item,
  business,
  disabled,
  onResolve,
}: {
  item: CategorizationReviewItem;
  business?: Business;
  disabled: boolean;
  onResolve: (item: CategorizationReviewItem, action: 'accept' | 'dismiss') => void;
}) {
  const confidence = item.payload.confidence == null ? null : Math.round(item.payload.confidence * 100);
  return (
    <article className="grid gap-3 rounded-lg border border-ink2/10 bg-cream/50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-bold text-ink">{item.title}</h3>
            <Badge variant="muted">{reviewTypeLabel(item.type)}</Badge>
            {confidence != null && <Badge variant="outline">{confidence}%</Badge>}
          </div>
          <p className="mt-1 text-sm text-dim">{item.detail}</p>
        </div>
        {business && (
          <span
            className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white"
            style={{ backgroundColor: business.color }}
          >
            {business.short}
          </span>
        )}
      </div>

      <div className="grid gap-1 text-xs text-dim sm:grid-cols-4">
        <ReviewFact label="Merchant" value={item.payload.merchant} />
        <ReviewFact label="Proposed" value={item.payload.proposedCategoryName} />
        <ReviewFact
          label="Rule"
          value={item.payload.proposedRule
            ? `${ruleKindLabel(item.payload.proposedRule.matchKind)} · ${item.payload.proposedRule.pattern}`
            : undefined}
        />
        <ReviewFact
          label="Matches"
          value={item.payload.matchCounts
            ? `${item.payload.matchCounts.uncategorized} uncategorized · ${item.payload.matchCounts.conflicts} conflicts`
            : item.payload.transactionIds?.length
              ? `${item.payload.transactionIds.length} transaction${item.payload.transactionIds.length === 1 ? '' : 's'}`
              : undefined}
        />
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => onResolve(item, 'dismiss')} disabled={disabled}>
          <X className="h-3.5 w-3.5" />
          Dismiss
        </Button>
        <Button size="sm" onClick={() => onResolve(item, 'accept')} disabled={disabled}>
          <Check className="h-3.5 w-3.5" />
          Accept
        </Button>
      </div>
    </article>
  );
}

function ReviewFact({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="min-w-0">
      <div className="font-bold uppercase tracking-wider">{label}</div>
      <div className="truncate text-ink">{value || '—'}</div>
    </div>
  );
}

export function reviewTypeLabel(type: CategorizationReviewItem['type']): string {
  switch (type) {
    case 'learn_rule_prompt':
      return 'Learn rule';
    case 'ai_category_suggestion':
      return 'AI suggestion';
    case 'receipt_category_override':
      return 'Receipt evidence';
    case 'rule_conflict_review':
      return 'Conflict';
    default:
      return 'Review';
  }
}

export function ruleKindLabel(kind: string): string {
  switch (kind) {
    case 'merchant_exact':
      return 'Merchant exact';
    case 'merchant_contains':
      return 'Merchant contains';
    case 'plaid_category':
      return 'Plaid category';
    case 'amount_range':
      return 'Amount range';
    default:
      return kind;
  }
}
