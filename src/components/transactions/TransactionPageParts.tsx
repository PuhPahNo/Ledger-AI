import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Boxes, Calendar, ChevronDown, ChevronUp, CreditCard, Landmark, Wallet } from 'lucide-react';
import type { Account, ReceiptStatus, TransactionRollup } from '@/types/domain';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/cn';

export function FacetGroup({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open?: boolean;
  onToggle?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="border-t border-ink2/8 py-2 first:border-t-0 first:pt-0">
      <button
        type="button"
        onClick={onToggle}
        disabled={!onToggle}
        className="mb-1.5 flex w-full items-center justify-between font-mono text-[10px] font-medium uppercase tracking-wider text-dim hover:text-ink"
      >
        <span>{label}</span>
        {onToggle && (open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}
      </button>
      {open !== false && children}
    </div>
  );
}

export function Metric({
  label,
  value,
  tone = 'default',
  detail,
  icon,
}: {
  label: string;
  value: string;
  tone?: 'default' | 'positive' | 'warning' | 'muted';
  detail?: string;
  icon?: ReactNode;
}) {
  return (
    <div
      className={cn(
        'rounded-xl border px-4 py-3 shadow-sm',
        tone === 'positive' && 'border-sage/40 bg-sage/10 text-sage-ink',
        tone === 'warning' && 'border-coral/40 bg-coral/10 text-coral-ink',
        tone === 'muted' && 'border-ink2/10 bg-paper text-dim',
        tone === 'default' && 'border-ink2/10 bg-paper',
      )}
    >
      <div className="flex items-center justify-between">
        <div className="font-mono text-[10px] uppercase tracking-wider text-dim">{label}</div>
        {icon}
      </div>
      <div className="mt-1 font-display text-xl font-bold tabular-nums">{value}</div>
      {detail && <div className="mt-1 truncate text-xs font-medium text-dim">{detail}</div>}
    </div>
  );
}

export function ReceiptPill({ status }: { status: ReceiptStatus }) {
  const variant =
    status === 'missing'
      ? 'danger'
      : status === 'matched'
        ? 'success'
        : status === 'pending'
          ? 'warning'
          : 'muted';
  return <Badge variant={variant}>{status}</Badge>;
}

export function AccountTypeIcon({ kind, className }: { kind: Account['kind']; className?: string }) {
  if (kind === 'credit') return <CreditCard className={className} />;
  if (kind === 'savings') return <Wallet className={className} />;
  if (kind === 'checking') return <Landmark className={className} />;
  return <Boxes className={className} />;
}

export function DateRangePill({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (range: { from: string; to: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const presets = useMemo(() => {
    const t = today();
    return [
      { label: 'Last 7 days', from: shiftDays(t, -7), to: t },
      { label: 'Last 30 days', from: shiftDays(t, -30), to: t },
      { label: 'This month', from: startOfMonth(), to: t },
      { label: 'Last 90 days', from: shiftDays(t, -90), to: t },
      { label: 'YTD', from: `${t.slice(0, 4)}-01-01`, to: t },
      { label: 'Last 12 months', from: shiftMonths(t, -12), to: t },
    ];
  }, []);
  const matched = presets.find((p) => p.from === from && p.to === to);
  const label = matched ? matched.label : `${from} → ${to}`;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-9 items-center gap-2 rounded-full border border-ink2/15 bg-paper px-3 text-xs font-bold text-ink hover:border-ink2/30"
      >
        <Calendar className="h-3.5 w-3.5 text-dim" />
        {label}
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-40 mt-1 w-[280px] rounded-xl border border-ink2/10 bg-paper p-2 shadow-lg">
            {presets.map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => {
                  onChange({ from: preset.from, to: preset.to });
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs font-bold transition-colors',
                  from === preset.from && to === preset.to ? 'bg-cream' : 'hover:bg-cream',
                )}
              >
                <span>{preset.label}</span>
                <span className="font-mono text-[10px] text-dim">
                  {preset.from.slice(5)} → {preset.to.slice(5)}
                </span>
              </button>
            ))}
            <div className="mt-2 grid grid-cols-2 gap-2 border-t border-ink2/10 pt-2">
              <label className="grid gap-1">
                <span className="font-mono text-[10px] uppercase tracking-wider text-dim">From</span>
                <input
                  type="date"
                  value={from}
                  onChange={(event) => onChange({ from: event.target.value, to })}
                  className="h-8 rounded-md border border-ink2/10 bg-paper px-2 text-xs"
                />
              </label>
              <label className="grid gap-1">
                <span className="font-mono text-[10px] uppercase tracking-wider text-dim">To</span>
                <input
                  type="date"
                  value={to}
                  onChange={(event) => onChange({ from, to: event.target.value })}
                  className="h-8 rounded-md border border-ink2/10 bg-paper px-2 text-xs"
                />
              </label>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function toggle<T>(value: T, values: T[]): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function startOfMonth(): string {
  return `${new Date().toISOString().slice(0, 7)}-01`;
}

export function ninetyDaysAgo(): string {
  const date = new Date();
  date.setDate(date.getDate() - 90);
  return date.toISOString().slice(0, 10);
}

export function shiftDays(value: string, delta: number): string {
  const date = new Date(`${value}T00:00:00`);
  date.setDate(date.getDate() + delta);
  return date.toISOString().slice(0, 10);
}

export function shiftMonths(value: string, delta: number): string {
  const date = new Date(`${value}T00:00:00`);
  date.setMonth(date.getMonth() + delta);
  return date.toISOString().slice(0, 10);
}

export function defaultFrom(): string {
  return shiftMonths(today(), -12);
}

export const emptyRollup: TransactionRollup = {
  rows: 0,
  inflowCents: 0,
  outflowCents: 0,
  operatingInflowCents: 0,
  operatingOutflowCents: 0,
  transferCents: 0,
  netCents: 0,
  missingReceipts: 0,
};
