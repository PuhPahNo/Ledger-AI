import type { ReactNode } from 'react';
import { AlertTriangle, Check, Minus } from 'lucide-react';
import type { Transaction } from '@/types/domain';
import type { MatchReason, MatchReasonStrength } from '@/types/receiptWorkflow';
import { cn } from '@/lib/cn';
import { fmt$ } from '@/lib/format';
import { shortDate, sortReasons } from './matchFormat';

export { relativeTime, shortDate } from './matchFormat';

const STRENGTH_CLASS: Record<MatchReasonStrength, string> = {
  strong: 'bg-sage/25 text-sage-ink',
  good: 'bg-sky/25 text-sky-ink dark:bg-sky/15 dark:text-sky',
  weak: 'bg-lemon/40 text-lemon-ink dark:bg-lemon/15 dark:text-lemon',
  conflict: 'bg-coral/15 text-coral-ink',
};

const STRENGTH_LABEL: Record<MatchReasonStrength, string> = {
  strong: 'Strong signal',
  good: 'Good signal',
  weak: 'Weak signal',
  conflict: 'Conflict',
};

export function ReasonChip({ reason }: { reason: MatchReason }) {
  const Icon = reason.strength === 'conflict' ? AlertTriangle : reason.strength === 'weak' ? Minus : Check;
  return (
    <span
      title={`${STRENGTH_LABEL[reason.strength]}: ${reason.text}`}
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold leading-4',
        STRENGTH_CLASS[reason.strength],
      )}
    >
      <Icon className="h-3 w-3 shrink-0" aria-hidden />
      <span className="truncate">{reason.text}</span>
    </span>
  );
}

export function ReasonChips({ reasons, className }: { reasons: MatchReason[]; className?: string }) {
  if (reasons.length === 0) return null;
  return (
    <div className={cn('flex min-w-0 flex-wrap gap-1', className)}>
      {sortReasons(reasons).map((reason) => (
        <ReasonChip key={`${reason.kind}-${reason.text}`} reason={reason} />
      ))}
    </div>
  );
}

/** A keyboard key hint, e.g. <Kbd>1</Kbd>. Hidden on touch-sized screens by the caller. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded border border-ink2/20 bg-paper px-1 font-mono text-[10px] font-medium leading-none text-dim shadow-xs',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function centsLabel(cents?: number | null): string {
  return cents == null ? '—' : fmt$(Math.abs(cents) / 100);
}

/** Merchant · date · account line for a transaction. */
export function TransactionFacts({ transaction, className }: { transaction: Transaction; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-dim', className)}>
      <span>{shortDate(transaction.date)}</span>
      <span aria-hidden>·</span>
      <span className="truncate">{transaction.src}</span>
      {transaction.cat && (
        <>
          <span aria-hidden className="hidden sm:inline">·</span>
          <span className="hidden truncate sm:inline">{transaction.cat}</span>
        </>
      )}
    </div>
  );
}
