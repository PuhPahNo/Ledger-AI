import { useCallback, useEffect, useState } from 'react';
import { getReceiptWorkflowCounts } from '@/api/receiptWorkflow';
import type { CurrentUser } from '@/types/domain';
import type { ReceiptWorkflowCounts } from '@/types/receiptWorkflow';
import type { NavigateFn, TransactionsMode, TransactionViewFilters } from '@/types/navigation';
import { useInbox } from '@/hooks/useInbox';
import { cn } from '@/lib/cn';
import { ReceiptsWorkbench } from './receipts/ReceiptsWorkbench';
import { TransactionsLedger } from './transactions/TransactionsLedger';

interface Props {
  user?: CurrentUser;
  onViewChange?: NavigateFn;
  onLogout?: () => void;
  mode: TransactionsMode;
  onModeChange: (mode: TransactionsMode) => void;
  initialFilters?: TransactionViewFilters;
}

/**
 * Transactions (#transactions) with two modes behind one segmented control:
 *   - Transactions → transactions/TransactionsLedger.tsx
 *   - Receipts     → receipts/ReceiptsWorkbench.tsx (#transactions/receipts; #receipts redirects)
 * Each mode owns its shell props (search, upload, filters); this component only switches.
 */
export function TransactionsPage({ user, onViewChange, onLogout, mode, onModeChange, initialFilters }: Props) {
  const { refresh: refreshInbox } = useInbox();
  const [counts, setCounts] = useState<ReceiptWorkflowCounts | null>(null);
  const refreshCounts = useCallback(() => {
    getReceiptWorkflowCounts().then(setCounts).catch(() => undefined);
  }, []);
  useEffect(refreshCounts, [refreshCounts, mode]);
  // While the queue is open its own count leads (it already excludes actions in their undo window).
  const [liveUnmatched, setLiveUnmatched] = useState<number | null>(null);
  const unmatched = counts?.unmatchedReceipts ?? null;
  const badgeCount = mode === 'receipts' && liveUnmatched != null ? liveUnmatched : unmatched;
  const modeSwitch = <ModeSwitch mode={mode} unmatched={badgeCount} onChange={onModeChange} />;
  if (mode === 'receipts') {
    return (
      <ReceiptsWorkbench
        user={user}
        onViewChange={onViewChange}
        onLogout={onLogout}
        modeSwitch={modeSwitch}
        unmatched={unmatched}
        onLiveUnmatchedChange={setLiveUnmatched}
        onReceiptsChanged={() => {
          refreshCounts();
          void refreshInbox();
        }}
      />
    );
  }
  return (
    <TransactionsLedger
      user={user}
      onViewChange={onViewChange}
      onLogout={onLogout}
      initialFilters={initialFilters}
      modeSwitch={modeSwitch}
      onReceiptsChanged={refreshCounts}
    />
  );
}

function ModeSwitch({
  mode,
  unmatched,
  onChange,
}: {
  mode: TransactionsMode;
  unmatched: number | null;
  onChange: (mode: TransactionsMode) => void;
}) {
  const options: Array<{ id: TransactionsMode; label: string; count?: string; countLabel?: string }> = [
    { id: 'transactions', label: 'Transactions' },
    {
      id: 'receipts',
      label: 'Receipts',
      count: unmatched ? String(unmatched) : undefined,
      countLabel: unmatched ? `${unmatched} unmatched receipt${unmatched === 1 ? '' : 's'}` : undefined,
    },
  ];
  return (
    <div role="tablist" aria-label="Transactions or receipts" className="flex w-full rounded-full bg-paper p-1 shadow-xs sm:w-fit">
      {options.map((option) => {
        const active = option.id === mode;
        return (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => !active && onChange(option.id)}
            className={cn(
              'inline-flex min-h-10 flex-1 items-center justify-center gap-2 rounded-full px-4 text-xs font-bold transition-colors sm:min-h-9 sm:flex-none',
              active ? 'bg-inverse text-inverse-foreground' : 'text-dim hover:text-ink',
            )}
          >
            {option.label}
            {option.count && (
              <span aria-label={option.countLabel} className={cn(
                'rounded-full px-1.5 py-0.5 text-[10px] tabular-nums leading-none',
                active ? 'bg-inverse-foreground text-inverse' : 'bg-coral/20 text-coral-ink',
              )}>
                {option.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
