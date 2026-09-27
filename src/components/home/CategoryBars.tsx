import { useState } from 'react';
import { PieChart } from 'lucide-react';
import type { CategoryComparison } from '@/types/domain';
import { fmtWholeCents } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

const COLLAPSED_ROWS = 8;

export function comparisonCents(row: CategoryComparison): { current: number; previous: number } {
  return {
    current: row.currentCents ?? Math.round(row.current * 100),
    previous: row.previousCents ?? Math.round(row.previous * 100),
  };
}

/**
 * Sorted horizontal bars: where the money went this period and how each category moved
 * against the comparison window. Rows are buttons (open Transactions filtered to them).
 * Shared by Home ("Where it went") and Reports › Overview ("Category mix").
 */
export function CategoryBars({
  rows,
  compareLabel,
  onSelect,
  emptyTitle = 'No spend in this period yet',
}: {
  rows: CategoryComparison[];
  /** e.g. "same days last month" — used in the delta tooltips. */
  compareLabel: string;
  onSelect?: (category: string) => void;
  emptyTitle?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const spent = rows
    .map((row) => ({ name: row.category, ...comparisonCents(row) }))
    .filter((row) => row.current > 0)
    .sort((a, b) => b.current - a.current);
  if (spent.length === 0) {
    return <EmptyState icon={<PieChart className="h-5 w-5" />} title={emptyTitle} className="py-10" />;
  }
  const max = spent[0].current;
  const visible = expanded ? spent : spent.slice(0, COLLAPSED_ROWS);
  return (
    <div className="grid gap-0.5">
      <ul className="grid gap-0.5" aria-label="Spend by category">
        {visible.map((row) => {
          const delta = row.previous > 0 ? Math.round(((row.current - row.previous) / row.previous) * 100) : null;
          const label = delta == null ? 'new' : `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${Math.abs(delta)}%`;
          const deltaTitle = delta == null
            ? `Nothing in ${compareLabel}`
            : `${fmtWholeCents(row.previous)} in ${compareLabel}`;
          const content = (
            <>
              <span className="flex min-w-0 items-baseline gap-2">
                <span className={cn('min-w-0 flex-1 truncate text-sm font-bold', row.name === 'Uncategorized' ? 'text-coral-ink' : 'text-ink')}>
                  {row.name}
                </span>
                <span className="font-display text-sm font-bold tabular-nums text-ink">{fmtWholeCents(row.current)}</span>
                <span
                  title={deltaTitle}
                  className={cn(
                    'w-12 shrink-0 text-right text-[11px] font-bold tabular-nums',
                    delta == null ? 'text-dim' : delta > 0 ? 'text-coral-ink' : delta < 0 ? 'text-sage-ink' : 'text-dim',
                  )}
                >
                  {label}
                </span>
              </span>
              <span className="mt-1 block h-2 overflow-hidden rounded-full bg-[hsl(var(--color-sunken))]" aria-hidden="true">
                <span
                  className="block h-full rounded-full"
                  style={{ width: `${Math.max(2, (row.current / max) * 100)}%`, background: 'hsl(var(--chart-2))' }}
                />
              </span>
            </>
          );
          return (
            <li key={row.name}>
              {onSelect ? (
                <button
                  type="button"
                  onClick={() => onSelect(row.name)}
                  aria-label={`${row.name}: ${fmtWholeCents(row.current)}, ${delta == null ? 'new this period' : `${label} vs ${compareLabel}`}. Show transactions.`}
                  className="block min-h-10 w-full rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-cream/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20"
                >
                  {content}
                </button>
              ) : (
                <div className="px-2 py-1.5">{content}</div>
              )}
            </li>
          );
        })}
      </ul>
      {spent.length > COLLAPSED_ROWS && (
        <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Show fewer' : `Show all ${spent.length}`}
        </Button>
      )}
    </div>
  );
}
