import { useState } from 'react';
import { BookOpen, Check, ChevronDown, ChevronUp, GitCompareArrows, Receipt, Sparkles, Wand2, X } from 'lucide-react';
import { resolveReviewGroup, resolveReviewItem } from '@/api/automation';
import type { Business } from '@/types/domain';
import type { ReviewGroup, ReviewGroupTransaction } from '@/types/automation';
import { useToast } from '@/hooks/useToast';
import { fmtWholeCents, fmt$ } from '@/lib/format';
import { parseLocalIsoDate } from '@/lib/dates';
import {
  itemsForGroup,
  reviewGroupActions,
  reviewGroupHeadline,
  reviewGroupKind,
  reviewGroupReason,
  type AnyReviewItem,
  type ReviewGroupKind,
} from '@/lib/reviewGroups';
import { Button } from '@/components/ui/button';
import { NeedsYouRow } from '../home/NeedsYouRow';

const KIND_ICON: Record<ReviewGroupKind, typeof Sparkles> = {
  conflict: GitCompareArrows,
  external: BookOpen,
  receipt: Receipt,
  learn: Wand2,
  ai: Sparkles,
  other: Sparkles,
};

/**
 * One grouped categorization decision in Home › Needs you: "12 × Gusto → Wages · $4,210"
 * with Accept all / Review / Dismiss. Review expands the sample transactions, each with its
 * own accept / dismiss.
 */
export function ReviewGroupRow({
  group,
  items,
  business,
  onResolved,
}: {
  group: ReviewGroup;
  /** All loaded open review items; the ones in this group are picked out. */
  items: AnyReviewItem[];
  business?: Business;
  onResolved: () => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const kind = reviewGroupKind(group);
  const groupItems = itemsForGroup(group, items);
  const actions = reviewGroupActions(group);
  const Icon = KIND_ICON[kind];
  const target = group.proposedCategoryName ?? 'the suggestion';

  const resolveAll = async (action: 'accept' | 'dismiss') => {
    setBusy(action);
    try {
      const result = await resolveReviewGroup(group, action);
      if (action === 'accept') {
        const filed = result.appliedCount || group.transactionCount;
        toast({
          variant: 'success',
          title: kind === 'conflict' ? `${group.merchant} rule now files ${target}` : `Filed ${filed} as ${target}`,
          description: [
            result.learnedRuleId ? `Future ${group.merchant} charges will be filed automatically.` : null,
            result.relabelledCount > 0 ? `${result.relabelledCount} older transaction${result.relabelledCount === 1 ? '' : 's'} relabelled.` : null,
            result.conflictCount > 0 ? `${result.conflictCount} kept — you'd set them yourself.` : null,
          ].filter(Boolean).join(' ') || undefined,
        });
      } else {
        toast({ title: kind === 'conflict' ? `Kept the ${group.merchant} rule` : 'Dismissed' });
      }
      onResolved();
    } catch (error) {
      toast({ variant: 'destructive', title: 'Review update failed', description: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setBusy(null);
    }
  };

  const resolveOne = async (item: AnyReviewItem, action: 'accept' | 'dismiss') => {
    setBusy(item.id);
    try {
      await resolveReviewItem(item.id, action);
      toast({ variant: action === 'accept' ? 'success' : 'default', title: action === 'accept' ? `Filed as ${target}` : 'Dismissed' });
      onResolved();
    } catch (error) {
      toast({ variant: 'destructive', title: 'Review update failed', description: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setBusy(null);
    }
  };

  const detail = [
    group.totalCents > 0 ? fmtWholeCents(group.totalCents) : null,
    reviewGroupReason(group, groupItems),
  ].filter(Boolean).join(' · ');

  return (
    <NeedsYouRow
      icon={<Icon className="h-4 w-4" />}
      tone={kind === 'conflict' ? 'danger' : 'warning'}
      title={(
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{reviewGroupHeadline(group)}</span>
          {business && <BizDot business={business} />}
        </span>
      )}
      detail={detail}
      wrapDetail
      action={(
        <>
          <Button size="sm" onClick={() => void resolveAll('accept')} disabled={Boolean(busy)}>
            <Check className="h-3.5 w-3.5" />
            {actions.accept}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
            {open ? 'Hide' : 'Review'}
            {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </Button>
          {kind === 'conflict' ? (
            <Button variant="ghost" size="sm" onClick={() => void resolveAll('dismiss')} disabled={Boolean(busy)}>
              {actions.dismiss}
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => void resolveAll('dismiss')}
              disabled={Boolean(busy)}
              title="Dismiss all"
              aria-label={`Dismiss ${reviewGroupHeadline(group)}`}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </>
      )}
    >
      {open && (
        <GroupDetail
          group={group}
          items={groupItems}
          busy={busy}
          onResolve={(item, action) => void resolveOne(item, action)}
        />
      )}
    </NeedsYouRow>
  );
}

function BizDot({ business }: { business: Business }) {
  return (
    <span
      className="shrink-0 rounded-full px-1.5 py-px text-[9px] font-bold uppercase tracking-wider text-white"
      style={{ backgroundColor: business.color }}
      title={business.name}
    >
      {business.short}
    </span>
  );
}

function itemTransactionIds(item: AnyReviewItem): string[] {
  return [...new Set([...(item.payload.transactionIds ?? []), ...(item.payload.transactionId ? [item.payload.transactionId] : [])])];
}

function shortDate(iso: string): string {
  return parseLocalIsoDate(iso.slice(0, 10)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Sample transactions, each with its own accept / dismiss when its review item is loaded. */
function GroupDetail({
  group,
  items,
  busy,
  onResolve,
}: {
  group: ReviewGroup;
  items: AnyReviewItem[];
  busy: string | null;
  onResolve: (item: AnyReviewItem, action: 'accept' | 'dismiss') => void;
}) {
  const kind = reviewGroupKind(group);
  const rows: Array<{ key: string; txn?: ReviewGroupTransaction; item?: AnyReviewItem }> = [];
  const seen = new Set<string>();
  for (const txn of group.sampleTransactions) {
    const item = items.find((candidate) => !seen.has(candidate.id) && itemTransactionIds(candidate).includes(txn.id));
    if (item) seen.add(item.id);
    rows.push({ key: txn.id, txn, item });
  }
  // Items with no sample transaction (e.g. a rule prompt) still get a line when nothing else shows.
  if (!rows.length) {
    for (const item of items.slice(0, 3)) rows.push({ key: item.id, item });
  }
  const hidden = Math.max(0, (group.transactionCount || group.itemCount) - rows.length);
  const multiple = group.itemCount > 1;

  return (
    <div className="mt-2 rounded-lg border border-ink2/10 bg-[hsl(var(--color-sunken))] sm:ml-11">
      <ul className="divide-y divide-ink2/10">
        {rows.map(({ key, txn, item }) => (
          <li key={key} className="flex items-center gap-2 px-3 py-1.5 text-xs">
            <div className="min-w-0 flex-1">
              {txn ? (
                <>
                  <div className="flex min-w-0 items-baseline gap-2">
                    <span className="shrink-0 font-mono text-dim">{shortDate(txn.date)}</span>
                    <span className="truncate font-bold text-ink">{txn.merchant}</span>
                    <span className="ml-auto shrink-0 font-mono text-ink">{fmt$(Math.abs(txn.amountCents) / 100)}</span>
                  </div>
                  <div className="truncate text-dim">
                    {kind === 'conflict' && item?.payload.currentCategoryName
                      ? `Rule says ${item.payload.currentCategoryName}`
                      : `Now ${txn.categoryName ?? 'Uncategorized'}`}
                  </div>
                </>
              ) : (
                <>
                  <div className="truncate font-bold text-ink">{item?.title}</div>
                  <div className="truncate text-dim">{item?.detail}</div>
                </>
              )}
            </div>
            {item && multiple && (
              <div className="flex shrink-0 items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={Boolean(busy)}
                  onClick={() => onResolve(item, 'accept')}
                  aria-label={`Accept this one${txn ? `: ${txn.merchant} ${shortDate(txn.date)}` : ''}`}
                  title="Accept this one"
                >
                  <Check className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={Boolean(busy)}
                  onClick={() => onResolve(item, 'dismiss')}
                  aria-label={`Dismiss this one${txn ? `: ${txn.merchant} ${shortDate(txn.date)}` : ''}`}
                  title="Dismiss this one"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {(hidden > 0 || group.learnsRule) && (
        <p className="border-t border-ink2/10 px-3 py-1.5 text-[11px] text-dim">
          {hidden > 0 && `+${hidden} more like these. `}
          {group.learnsRule && (kind === 'conflict'
            ? `Switching updates the rule and relabels past ${group.merchant} charges.`
            : `Accepting all also files future ${group.merchant} charges automatically.`)}
        </p>
      )}
    </div>
  );
}
