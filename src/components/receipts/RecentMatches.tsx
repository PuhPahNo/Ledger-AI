import { useEffect, useState } from 'react';
import { ArrowRight, ExternalLink, Link2, RefreshCw, Undo2, XCircle } from 'lucide-react';
import { receiptFileUrl } from '@/api';
import { undoMatch } from '@/api/receiptWorkflow';
import type { RecentMatch } from '@/types/receiptWorkflow';
import { useToast } from '@/hooks/useToast';
import { cn } from '@/lib/cn';
import { fmt$ } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { ReasonChips, TransactionFacts, centsLabel, relativeTime } from './MatchParts';
import { receiptLabel } from './ReceiptWorkbenchParts';

interface Props {
  items: RecentMatch[] | null;
  error: string | null;
  onRetry: () => void;
  /** Called after an undo so counts and the list refresh. */
  onUndone: (receiptId: string) => void;
}

/**
 * "Matched this week": every pair still in place from the last 7 days — automatic ones first to
 * skim — with one-click Undo (unpair). An undone pair is never proposed again.
 */
export function RecentMatches({ items, error, onRetry, onUndone }: Props) {
  const { toast } = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  useEffect(() => {
    setHidden(new Set());
  }, [items]);

  if (error) {
    return (
      <EmptyState
        title="Couldn't load recent matches"
        description={error}
        icon={<XCircle className="h-5 w-5" />}
        action={<Button variant="outline" onClick={onRetry}><RefreshCw className="h-4 w-4" />Retry</Button>}
      />
    );
  }

  if (!items) {
    return (
      <div className="grid gap-2" aria-busy="true">
        {[0, 1, 2, 3].map((key) => <Skeleton key={key} className="h-24 rounded-xl" />)}
      </div>
    );
  }

  const rows = items.filter((row) => !hidden.has(row.receipt.id));
  if (rows.length === 0) {
    return (
      <EmptyState
        className="py-16"
        title="Nothing matched this week"
        description="Pairs made automatically or from the queue show up here for a quick look."
        icon={<Link2 className="h-5 w-5" />}
      />
    );
  }

  const auto = rows.filter((row) => row.mode === 'auto').length;

  const handleUndo = async (match: RecentMatch) => {
    setBusyId(match.receipt.id);
    setHidden((current) => new Set(current).add(match.receipt.id));
    try {
      await undoMatch(match.receipt.id);
      toast({
        title: 'Unpaired',
        description: `${receiptLabel(match.receipt)} is back in the queue and won't be paired with ${match.transaction.merchant} again.`,
      });
      onUndone(match.receipt.id);
    } catch (undoError) {
      setHidden((current) => {
        const next = new Set(current);
        next.delete(match.receipt.id);
        return next;
      });
      toast({ variant: 'destructive', title: 'Could not unpair', description: undoError instanceof Error ? undoError.message : 'Try again.' });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="grid gap-2">
      <p className="px-1 text-xs text-dim">
        {auto} automatic · {rows.length - auto} by hand. Undo anything that looks wrong — it goes back to the queue.
      </p>
      <ul className="grid gap-2">
        {rows.map((match) => (
          <li key={match.matchId} className="flex min-w-0 flex-col gap-3 rounded-xl border border-ink2/10 bg-paper p-3 shadow-sm sm:flex-row sm:items-start">
            <div className="grid min-w-0 flex-1 gap-2">
              <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center sm:gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <ModeBadge mode={match.mode} />
                    <span className="text-[11px] text-dim">{relativeTime(match.matchedAt)}</span>
                  </div>
                  <div className="mt-1 truncate font-bold text-ink" title={receiptLabel(match.receipt)}>{receiptLabel(match.receipt)}</div>
                  <div className="text-xs text-dim">Receipt · {centsLabel(match.receipt.totalCents)}</div>
                </div>
                <ArrowRight className="hidden h-4 w-4 text-dim sm:block" aria-hidden />
                <div className="min-w-0">
                  <div className="flex min-w-0 items-baseline justify-between gap-2">
                    <span className="truncate font-bold text-ink" title={match.transaction.merchant}>{match.transaction.merchant}</span>
                    <span className="shrink-0 font-display font-bold tabular-nums">{fmt$(Math.abs(match.transaction.amount))}</span>
                  </div>
                  <TransactionFacts transaction={match.transaction} />
                </div>
              </div>
              <ReasonChips reasons={match.explanations} />
            </div>
            <div className="flex shrink-0 gap-2">
                <Button asChild variant="ghost" size="sm" className="flex-1 sm:flex-none">
                  <a href={receiptFileUrl(match.receipt.id)} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-3.5 w-3.5" />
                    View
                  </a>
                </Button>
                <Button variant="outline" size="sm" className="flex-1 sm:flex-none" disabled={busyId === match.receipt.id} onClick={() => handleUndo(match)}>
                  <Undo2 className="h-3.5 w-3.5" />
                  Undo
                </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ModeBadge({ mode }: { mode: RecentMatch['mode'] }) {
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
        mode === 'auto' ? 'bg-sky/25 text-sky-ink dark:bg-sky/15 dark:text-sky' : 'bg-ink/5 text-dim',
      )}
    >
      {mode === 'auto' ? 'Auto' : 'Manual'}
    </span>
  );
}
