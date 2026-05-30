import type { Business, Transaction } from '@/types/domain';
import { fmt$k } from '@/lib/format';
import { spendForBusiness, totalSpend } from '@/lib/calc';
import { cn } from '@/lib/cn';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { MoneyDisplay } from '@/components/ui/money-display';
import { StatLabel } from '@/components/ui/stat-label';
import { useResolvedColor } from '@/hooks/useTheme';

interface Props {
  businesses: Business[];
  transactions: Transaction[];
  selected: string;
  onSelect: (businessId: string) => void;
  captionFor: (business: Business) => string;
}

export function BusinessStrip({ businesses, transactions, selected, onSelect, captionFor }: Props) {
  // "All businesses" uses the primary ink as its accent — resolve it so it stays visible in dark mode.
  const allAccent = useResolvedColor('--color-ink', '#15140f');
  return (
    <ScrollArea className="w-full">
      <div className="flex gap-3 pb-2">
        <BusinessCard
          active={selected === 'all'}
          accent={allAccent}
          name="All businesses"
          amount={fmt$k(totalSpend(transactions))}
          caption={`${businesses.length} workspaces`}
          onClick={() => onSelect('all')}
        />
        {businesses.map((business) => (
          <BusinessCard
            key={business.id}
            active={selected === business.id}
            accent={business.color}
            name={business.name}
            amount={fmt$k(spendForBusiness(transactions, business.id))}
            caption={captionFor(business)}
            onClick={() => onSelect(business.id)}
          />
        ))}
      </div>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  );
}

interface CardProps {
  active: boolean;
  accent: string;
  name: string;
  amount: string;
  caption: string;
  onClick: () => void;
}

function BusinessCard({ active, accent, name, amount, caption, onClick }: CardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group relative flex w-56 shrink-0 flex-col items-start gap-1.5 overflow-hidden rounded-xl border bg-paper p-4 text-left shadow-sm transition-all',
        'hover:-translate-y-px hover:shadow-md',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2',
        active ? 'border-ink2/30' : 'border-ink2/8',
      )}
      style={{ scrollSnapAlign: 'start' }}
    >
      <span
        className="absolute inset-y-0 left-0 w-1 transition-all group-hover:w-1.5"
        style={{ background: accent }}
        aria-hidden
      />
      <StatLabel className="text-ink/70">{name}</StatLabel>
      <MoneyDisplay size="md">{amount}</MoneyDisplay>
      <div className="text-xs text-dim">{caption}</div>
      {active && (
        <span
          className="absolute right-3 top-3 h-1.5 w-1.5 rounded-full"
          style={{ background: accent }}
          aria-hidden
        />
      )}
    </button>
  );
}
