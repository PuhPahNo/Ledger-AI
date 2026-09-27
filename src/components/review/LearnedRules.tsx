import { useEffect, useState } from 'react';
import { Undo2, Wand2 } from 'lucide-react';
import { listLearnedRules, undoLearnedRule } from '@/api/automation';
import type { LearnedRule } from '@/types/automation';
import { useToast } from '@/hooks/useToast';
import { learnedViaLabel, timeAgo } from '@/lib/reviewGroups';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Rules the categorizer learned (merchant → category), newest first, each undoable. Undo
 * removes (or restores) the rule and puts back exactly what it relabelled, skipping anything
 * someone has changed since.
 */
export function LearnedRulesList({
  days,
  includeUndone = true,
  onChanged,
}: {
  days: number;
  includeUndone?: boolean;
  onChanged?: () => void;
}) {
  const { toast } = useToast();
  const [rules, setRules] = useState<LearnedRule[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError('');
    listLearnedRules({ days, includeUndone, via: 'all' })
      .then((rows) => !cancelled && setRules(rows))
      .catch((loadError: Error) => !cancelled && setError(loadError.message));
    return () => {
      cancelled = true;
    };
  }, [days, includeUndone]);

  const undo = async (rule: LearnedRule) => {
    setBusy(rule.id);
    try {
      const result = await undoLearnedRule(rule.id);
      setRules((rows) => rows?.map((row) => (row.id === rule.id
        ? { ...row, undoneAt: result.undoneAt ?? new Date().toISOString(), undoRestoredCount: result.restoredCount, ruleActive: false }
        : row)) ?? null);
      toast({
        variant: 'success',
        title: result.alreadyUndone ? 'Already undone' : `Undid ${rule.merchant} → ${rule.categoryName ?? 'rule'}`,
        description: result.alreadyUndone ? undefined : [
          `${result.restoredCount} restored`,
          result.skippedCount ? `${result.skippedCount} skipped (changed since)` : null,
        ].filter(Boolean).join(' · '),
      });
      onChanged?.();
    } catch (undoError) {
      toast({ variant: 'destructive', title: 'Undo failed', description: undoError instanceof Error ? undoError.message : 'Try again.' });
    } finally {
      setBusy(null);
    }
  };

  if (error) {
    return <div role="alert" className="rounded-lg border border-coral/30 bg-coral/10 p-3 text-sm font-bold text-coral-ink">Couldn't load learned rules: {error}</div>;
  }
  if (!rules) {
    return (
      <div className="grid gap-2" aria-hidden="true">
        {[0, 1, 2].map((index) => <Skeleton key={index} className="h-14" />)}
      </div>
    );
  }
  if (!rules.length) {
    return (
      <EmptyState
        icon={<Wand2 className="h-5 w-5" />}
        title="Nothing learned yet"
        description={`No rules learned in the last ${days} days. When you file a merchant the same way a few times, a rule is learned here.`}
      />
    );
  }
  return (
    <ul className="divide-y divide-ink2/10 rounded-lg border border-ink2/10">
      {rules.map((rule) => {
        const undone = Boolean(rule.undoneAt);
        return (
          <li key={rule.id} className="flex items-center gap-3 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className={cn('flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-bold', undone ? 'text-dim' : 'text-ink')}>
                <span className={cn('truncate', undone && 'line-through')}>
                  {rule.merchant} → {rule.categoryName ?? 'Unknown category'}
                </span>
                {undone && <Badge variant="muted">Undone</Badge>}
              </div>
              <div className="text-xs text-dim">
                {[
                  undone
                    ? `Undone ${timeAgo(rule.undoneAt)}${rule.undoRestoredCount != null ? ` · ${rule.undoRestoredCount} restored` : ''}`
                    : `${capitalize(learnedViaLabel(rule.learnedVia))} ${timeAgo(rule.createdAt)}`,
                  !undone && rule.relabelledCount > 0 ? `${rule.relabelledCount} relabelled` : null,
                  rule.previousCategoryName ? `was ${rule.previousCategoryName}` : null,
                  rule.businessName,
                ].filter(Boolean).join(' · ')}
              </div>
            </div>
            {!undone && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy === rule.id}
                onClick={() => void undo(rule)}
                aria-label={`Undo ${rule.merchant} → ${rule.categoryName ?? 'rule'}`}
              >
                <Undo2 className="h-3.5 w-3.5" />
                Undo
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** The digest opened from Home's "N rules learned". */
export function LearnedRulesSheet({
  open,
  onOpenChange,
  days,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  days: number;
  onChanged?: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="p-4 sm:p-6">
        <SheetHeader className="pr-8">
          <SheetTitle>Rules learned</SheetTitle>
          <SheetDescription>
            Last {days} days. Undo puts back what a rule relabelled and skips anything changed since.
          </SheetDescription>
        </SheetHeader>
        {open && <LearnedRulesList days={days} onChanged={onChanged} />}
      </SheetContent>
    </Sheet>
  );
}
