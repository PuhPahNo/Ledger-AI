import type { Business, Transaction } from '@/types/domain';
import { fmt$ } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/badge';

/** The latest few transactions; the full, filterable list is one click away in Transactions. */
export function RecentActivity({
  transactions,
  businesses,
  onSelect,
}: {
  transactions: Transaction[];
  businesses: Business[];
  onSelect: (transaction: Transaction) => void;
}) {
  if (!transactions.length) {
    return <div className="px-2 py-6 text-center text-sm text-dim">No transactions in this period yet.</div>;
  }
  const businessById = new Map(businesses.map((business) => [business.id, business]));
  return (
    <ul className="divide-y divide-ink2/10">
      {transactions.map((txn) => {
        const business = businessById.get(txn.biz);
        const receipt = receiptGlyph(txn.receipt);
        return (
          <li key={txn.id}>
            <button
              type="button"
              onClick={() => onSelect(txn)}
              className="flex min-h-12 w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-cream/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20"
            >
              <span
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md font-bold"
                style={business ? { background: `${business.color}22`, color: business.color } : { background: 'hsl(var(--color-dim) / 0.15)' }}
                aria-hidden="true"
              >
                {txn.merchant[0]}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-bold text-ink" title={txn.merchant}>{txn.merchant}</span>
                  {txn.flag === 'dup-sub' && <Badge variant="danger" className="px-1.5 py-0 text-[9px]">DUP</Badge>}
                </span>
                <span className="block truncate text-xs text-dim">
                  {txn.dateLabel} · {business?.short ?? txn.biz} · <span className={txn.cat === 'Uncategorized' ? 'text-coral-ink' : undefined}>{txn.cat}</span>
                </span>
              </span>
              <span
                title={receipt.title}
                aria-label={receipt.title}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold"
                style={{ background: receipt.bg, color: receipt.fg }}
              >
                {receipt.glyph}
              </span>
              <span className={cn('w-20 shrink-0 text-right font-display text-sm font-bold tabular-nums sm:w-24', txn.amount > 0 ? 'text-sage-ink' : 'text-ink')}>
                {fmt$(txn.amount)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function receiptGlyph(status: Transaction['receipt']) {
  switch (status) {
    case 'matched':
      return { fg: 'hsl(var(--on-sage))', bg: 'hsl(var(--color-sage))', glyph: '✓', title: 'Receipt matched' };
    case 'missing':
      return { fg: 'hsl(var(--on-coral))', bg: 'hsl(var(--color-coral))', glyph: '!', title: 'Receipt missing' };
    case 'pending':
      return { fg: 'hsl(var(--color-lemon-ink))', bg: 'hsl(var(--color-lemon))', glyph: '…', title: 'Receipt pending' };
    default:
      return { fg: 'hsl(var(--color-dim))', bg: 'transparent', glyph: '—', title: 'No receipt needed' };
  }
}
