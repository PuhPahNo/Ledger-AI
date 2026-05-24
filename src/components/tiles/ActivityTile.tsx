import { useState } from 'react';
import type { Business, Transaction } from '@/types/domain';
import { fmt$ } from '@/lib/format';
import { Tile } from '@/components/ui/tile';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/cn';

interface Props {
  transactions: Transaction[];
  businesses: Business[];
  totalCount: number;
  onSelect?: (transaction: Transaction) => void;
  onViewAll?: () => void;
}

const FILTERS = ['All', 'Software', 'Travel', 'Meals'] as const;
type Filter = (typeof FILTERS)[number];

export function ActivityTile({ transactions, businesses, totalCount, onSelect, onViewAll }: Props) {
  const [filter, setFilter] = useState<Filter>('All');
  const visible = (filter === 'All' ? transactions : transactions.filter((t) => t.cat === filter)).slice(0, 12);

  return (
    <Tile tone="paper" pad="none" colSpan={8} rowSpan={3} className="overflow-hidden">
      <div className="flex flex-wrap items-baseline gap-3 px-5 pb-3 pt-5">
        <div className="font-display text-lg font-bold tracking-tight">Activity</div>
        <span className="font-mono text-[10px] uppercase tracking-wider text-dim">
          {visible.length} of {totalCount}
        </span>
        <span className="flex-1" />
        <ToggleGroup
          type="single"
          value={filter}
          onValueChange={(value) => value && setFilter(value as Filter)}
          className="bg-[hsl(var(--color-sunken))]"
        >
          {FILTERS.map((s) => (
            <ToggleGroupItem key={s} value={s}>
              {s}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Button variant="outline" size="sm" onClick={onViewAll}>
          View all
        </Button>
      </div>
      <Separator />
      <ScrollArea className="flex-1">
        <div className="grid divide-y divide-ink2/8 px-2 pb-3">
          {visible.map((t) => (
            <ActivityRow key={t.id} transaction={t} businesses={businesses} onSelect={onSelect} />
          ))}
          {!visible.length && (
            <div className="px-3 py-6 text-center text-sm text-dim">No transactions match this filter yet.</div>
          )}
        </div>
      </ScrollArea>
    </Tile>
  );
}

function ActivityRow({
  transaction: t,
  businesses,
  onSelect,
}: {
  transaction: Transaction;
  businesses: Business[];
  onSelect?: (transaction: Transaction) => void;
}) {
  const business = businesses.find((x) => x.id === t.biz);
  const rcpt = receiptBadge(t.receipt);
  const merchant = limitMerchant(t.merchant);
  if (!business) return null;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect?.(t)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect?.(t);
        }
      }}
      className={cn(
        'group flex items-center gap-3 rounded-lg px-3 py-2 transition-colors',
        'hover:bg-cream/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20',
        onSelect ? 'cursor-pointer' : 'cursor-default',
      )}
    >
      <div
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md font-bold"
        style={{ background: business.color + '22', color: business.color }}
      >
        {t.merchant[0]}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="block min-w-0 flex-1 truncate text-sm font-bold text-ink" title={t.merchant}>
            {merchant}
          </span>
          {t.flag === 'dup-sub' && <Badge variant="danger" className="px-1.5 py-0 text-[9px]">DUP</Badge>}
        </div>
        <div className="truncate text-xs text-dim">
          {t.dateLabel} · {business.name} · {t.cat}
        </div>
      </div>
      <span
        title={rcpt.title}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold"
        style={{ background: rcpt.bg, color: rcpt.fg }}
      >
        {rcpt.glyph}
      </span>
      <div
        className={cn(
          'w-24 shrink-0 text-right font-display text-sm font-bold tabular-nums',
          t.amount > 0 ? 'text-sage-ink' : 'text-ink',
        )}
      >
        {fmt$(t.amount)}
      </div>
    </div>
  );
}

function limitMerchant(value: string, max = 58): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function receiptBadge(status: Transaction['receipt']) {
  switch (status) {
    case 'matched':
      return { fg: 'hsl(var(--color-sage-ink))', bg: 'hsl(var(--color-sage))', glyph: '✓', title: 'Receipt matched' };
    case 'missing':
      return { fg: 'hsl(var(--color-coral-ink))', bg: 'hsl(var(--color-coral))', glyph: '!', title: 'Receipt missing' };
    case 'pending':
      return { fg: 'hsl(var(--color-lemon-ink))', bg: 'hsl(var(--color-lemon))', glyph: '…', title: 'Receipt pending OCR/match' };
    default:
      return { fg: 'hsl(var(--color-dim))', bg: 'transparent', glyph: '—', title: 'Not applicable' };
  }
}
