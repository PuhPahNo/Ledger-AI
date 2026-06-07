import { useMemo, useState } from 'react';
import { Check, Sparkles, X } from 'lucide-react';
import { resolveCategorizationReviewItem } from '@/api';
import type { Business, CategorizationReviewItem } from '@/types/domain';
import { useToast } from '@/hooks/useToast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface Props {
  open: boolean;
  items: CategorizationReviewItem[];
  businesses: Business[];
  onClose: () => void;
  onResolved: () => void;
}

export function CategorizationReviewCenter({ open, items, businesses, onClose, onResolved }: Props) {
  const { toast } = useToast();
  const [resolving, setResolving] = useState<string | null>(null);
  const businessByKey = useMemo(() => new Map(businesses.map((business) => [business.id, business])), [businesses]);
  const aiSuggestions = items.filter((item) => item.type === 'ai_category_suggestion');

  const resolve = async (item: CategorizationReviewItem, action: 'accept' | 'dismiss') => {
    setResolving(item.id);
    try {
      const result = await resolveCategorizationReviewItem(item.id, action);
      toast({
        variant: action === 'accept' ? 'success' : 'default',
        title: action === 'accept' ? 'Applied' : 'Dismissed',
        description: result.appliedCount > 0
          ? `${result.appliedCount} transaction${result.appliedCount === 1 ? '' : 's'} updated.`
          : undefined,
      });
      onResolved();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Review update failed',
        description: error instanceof Error ? error.message : 'Try again.',
      });
    } finally {
      setResolving(null);
    }
  };

  const acceptAiSuggestions = async () => {
    for (const item of aiSuggestions) {
      await resolve(item, 'accept');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="lg" className="gap-5">
        <DialogHeader>
          <DialogTitle>Notifications</DialogTitle>
          <DialogDescription>
            {items.length ? `${items.length} categorization item${items.length === 1 ? '' : 's'} waiting` : 'No categorization items waiting'}
          </DialogDescription>
        </DialogHeader>

        {aiSuggestions.length > 1 && (
          <div className="flex justify-end">
            <Button size="sm" variant="secondary" onClick={acceptAiSuggestions} disabled={Boolean(resolving)}>
              <Sparkles className="h-3.5 w-3.5" />
              Accept AI suggestions
            </Button>
          </div>
        )}

        <div className="grid max-h-[62vh] gap-3 overflow-auto pr-1">
          {items.length === 0 ? (
            <div className="rounded-lg border border-ink2/10 bg-cream/60 p-5 text-sm text-dim">
              You are caught up.
            </div>
          ) : items.map((item) => {
            const business = businessByKey.get(item.biz);
            const confidence = item.payload.confidence == null ? null : Math.round(item.payload.confidence * 100);
            const disabled = resolving === item.id;
            return (
              <article key={item.id} className="grid gap-3 rounded-lg border border-ink2/10 bg-cream/50 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-sm font-bold text-ink">{item.title}</h3>
                      <Badge variant="muted">{labelForType(item.type)}</Badge>
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
                  <Button variant="ghost" size="sm" onClick={() => resolve(item, 'dismiss')} disabled={disabled}>
                    <X className="h-3.5 w-3.5" />
                    Dismiss
                  </Button>
                  <Button size="sm" onClick={() => resolve(item, 'accept')} disabled={disabled}>
                    <Check className="h-3.5 w-3.5" />
                    Accept
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
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

function labelForType(type: CategorizationReviewItem['type']): string {
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

function ruleKindLabel(kind: string): string {
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
