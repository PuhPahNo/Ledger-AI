import type { ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
import type { Account } from '@/types/domain';
import type { PaceComparison } from '@/lib/periods';
import { fmtDeltaPct, fmtWholeCents } from '@/lib/format';
import { cn } from '@/lib/cn';

interface Props {
  spend: PaceComparison;
  income: PaceComparison;
  net: PaceComparison;
  /** "same day last month" / "same point last period". */
  compareLabel: string;
  accounts: Account[];
  onOpenSpend: () => void;
  onOpenIncome: () => void;
  onOpenNet: () => void;
  onOpenAccounts: () => void;
}

/** Cash on hand = current balances of watched bank (non-card) accounts. */
export function cashOnHand(accounts: Account[]): { cents: number; accounts: number } {
  const banks = accounts.filter((account) => account.enabled && account.kind !== 'credit' && account.currentBalanceCents != null);
  return { cents: banks.reduce((sum, account) => sum + (account.currentBalanceCents ?? 0), 0), accounts: banks.length };
}

/** The four numbers Home leads with. Every tile opens the place that explains it. */
export function KpiRow({ spend, income, net, compareLabel, accounts, onOpenSpend, onOpenIncome, onOpenNet, onOpenAccounts }: Props) {
  const cash = cashOnHand(accounts);
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Kpi
        label="Spend"
        value={fmtWholeCents(spend.currentCents)}
        delta={spend.deltaPct}
        // More spend is the bad direction.
        goodWhenUp={false}
        detail={`${fmtDeltaPct(spend.deltaPct)} vs ${compareLabel}`}
        onClick={onOpenSpend}
      />
      <Kpi
        label="Income"
        value={fmtWholeCents(income.currentCents)}
        delta={income.deltaPct}
        goodWhenUp
        detail={`${fmtDeltaPct(income.deltaPct)} vs ${compareLabel}`}
        onClick={onOpenIncome}
      />
      <Kpi
        label="Net"
        value={fmtWholeCents(net.currentCents, { signed: true })}
        valueClassName={net.currentCents < 0 ? 'text-coral-ink' : undefined}
        delta={net.currentCents - net.previousCents === 0 ? null : net.currentCents - net.previousCents}
        goodWhenUp
        detail={`${fmtWholeCents(net.currentCents - net.previousCents, { signed: true })} vs ${compareLabel}`}
        onClick={onOpenNet}
      />
      <Kpi
        label="Cash on hand"
        value={cash.accounts ? fmtWholeCents(cash.cents) : '—'}
        detail={cash.accounts ? `Now · ${cash.accounts} bank account${cash.accounts === 1 ? '' : 's'}` : 'No bank balances synced'}
        onClick={onOpenAccounts}
      />
    </div>
  );
}

function Kpi({
  label,
  value,
  detail,
  delta,
  goodWhenUp,
  valueClassName,
  onClick,
}: {
  label: string;
  value: ReactNode;
  detail: string;
  delta?: number | null;
  goodWhenUp?: boolean;
  valueClassName?: string;
  onClick: () => void;
}) {
  const tone = delta == null || delta === 0 || goodWhenUp == null
    ? 'text-dim'
    : (delta > 0) === goodWhenUp ? 'text-sage-ink' : 'text-coral-ink';
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-h-[92px] min-w-0 flex-col rounded-xl border border-ink2/10 bg-paper px-4 py-3 text-left shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20"
    >
      <span className="flex items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-wider text-dim">
        {label}
        <ArrowUpRight className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
      </span>
      <span className={cn('mt-1 truncate font-display text-xl font-bold tabular-nums text-ink sm:text-2xl', valueClassName)}>{value}</span>
      <span className={cn('mt-auto line-clamp-2 pt-1 text-xs font-medium', tone)}>{detail}</span>
    </button>
  );
}
