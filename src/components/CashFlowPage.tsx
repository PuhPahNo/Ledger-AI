import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Download,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { getCashFlow, listAccounts, listBusinesses, listCategories, uploadReceipt } from '@/api';
import type {
  Account,
  Business,
  CashFlowPeriod,
  CashFlowSummary,
  Category,
  CurrentUser,
} from '@/types/domain';
import type { AppView } from '@/types/navigation';
import { accountLabel } from '@/lib/account';
import { useToast } from '@/hooks/useToast';
import { AppShell } from './AppShell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/cn';

interface Props {
  user?: CurrentUser;
  onViewChange?: (view: AppView) => void;
  onLogout?: () => void;
}

const emptyCashFlow: CashFlowSummary = {
  from: '',
  to: '',
  group: 'month',
  includeTransfers: false,
  totals: {
    inflowCents: 0,
    outflowCents: 0,
    transferCents: 0,
    netCents: 0,
    previousInflowCents: 0,
    previousOutflowCents: 0,
    previousTransferCents: 0,
    previousNetCents: 0,
    netDeltaCents: 0,
    netDeltaPct: 0,
  },
  periods: [],
};

export function CashFlowPage({ user, onViewChange, onLogout }: Props) {
  const { toast } = useToast();
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [business, setBusiness] = useState('all');
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [includeTransfers, setIncludeTransfers] = useState(false);
  const [from, setFrom] = useState(defaultFrom());
  const [to, setTo] = useState(today());
  const [summary, setSummary] = useState<CashFlowSummary>(emptyCashFlow);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    Promise.all([listBusinesses(), listAccounts()])
      .then(([businessRows, accountRows]) => {
        setBusinesses(businessRows);
        setAccounts(accountRows);
      })
      .catch((loadError: Error) => setError(loadError.message));
  }, []);

  useEffect(() => {
    setLoading(true);
    setError('');
    getCashFlow({
      from,
      to,
      group: 'month',
      includeTransfers,
      biz: business,
      accountIds,
    })
      .then(setSummary)
      .catch((loadError: Error) => setError(loadError.message))
      .finally(() => setLoading(false));
  }, [accountIds, business, from, includeTransfers, refreshKey, to]);

  // Pull category mix for the currently selected month (latest period in the response).
  useEffect(() => {
    const latest = summary.periods.at(-1);
    if (!latest) {
      setCategories([]);
      return;
    }
    listCategories({
      from: latest.from,
      to: latest.to,
      biz: business,
      accountIds,
    })
      .then((rows) =>
        [...rows]
          .sort((a, b) => (b.amountCents ?? Math.round(b.amount * 100)) - (a.amountCents ?? Math.round(a.amount * 100)))
          .slice(0, 8),
      )
      .then(setCategories)
      .catch(() => setCategories([]));
  }, [accountIds, business, summary.periods]);

  const selectedBusinessDbId = business === 'all' ? undefined : businesses.find((item) => item.id === business)?.dbId;

  const handleUpload = async (file: File) => {
    try {
      await uploadReceipt(file, selectedBusinessDbId);
      toast({ variant: 'success', title: 'Receipt queued', description: 'OCR and matching will run in the background.' });
      setRefreshKey((key) => key + 1);
    } catch (uploadError) {
      toast({
        variant: 'destructive',
        title: 'Upload failed',
        description: uploadError instanceof Error ? uploadError.message : 'Try again.',
      });
    }
  };

  // Periods are returned chronologically (oldest first). Newest = "this month".
  const periods = summary.periods;
  const thisMonth = periods.at(-1) ?? null;
  const lastMonth = periods.length >= 2 ? periods.at(-2)! : null;

  const moDelta = lastMonth && lastMonth.netCents !== 0
    ? Math.round(((thisMonth!.netCents - lastMonth.netCents) / Math.abs(lastMonth.netCents)) * 100)
    : 0;
  const yoyDelta = thisMonth?.netDeltaPct ?? 0;

  const compareCards: ComparisonCardData[] = useMemo(() => {
    if (!thisMonth) return [];
    return [
      {
        label: 'This month',
        sub: `${thisMonth.label} · net cash`,
        inflowCents: thisMonth.inflowCents,
        outflowCents: thisMonth.outflowCents,
        netCents: thisMonth.netCents,
        current: true,
        moDelta,
        yoyDelta,
      },
      {
        label: 'Last month',
        sub: lastMonth ? `${lastMonth.label} · net cash` : 'no prior month',
        inflowCents: lastMonth?.inflowCents ?? 0,
        outflowCents: lastMonth?.outflowCents ?? 0,
        netCents: lastMonth?.netCents ?? 0,
        current: false,
      },
      {
        label: 'Same month, last year',
        sub: `${prevYearLabel(thisMonth.label)} · net cash`,
        inflowCents: thisMonth.previousInflowCents,
        outflowCents: thisMonth.previousOutflowCents,
        netCents: thisMonth.previousNetCents,
        current: false,
      },
    ];
  }, [thisMonth, lastMonth, moDelta, yoyDelta]);

  const focusedTitle = thisMonth ? `How does ${thisMonth.label} compare?` : 'Cash flow';

  const visibleAccounts = business === 'all' ? accounts : accounts.filter((account) => account.biz === business);

  return (
    <AppShell
      currentView="cash-flow"
      onViewChange={onViewChange}
      onLogout={onLogout}
      user={user}
      onUploadReceipt={handleUpload}
      contextEyebrow="Cash-basis reporting"
      contextTitle="Cash flow"
      businesses={businesses}
      selectedBusiness={business}
      onBusinessChange={(value) => {
        setBusiness(value);
        setAccountIds([]);
      }}
      contextActions={
        <label className="hidden items-center gap-2 text-xs font-bold text-ink lg:flex">
          <Switch checked={includeTransfers} onCheckedChange={setIncludeTransfers} />
          Include transfers
        </label>
      }
    >
      <div className="flex flex-col gap-4">
        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">
              Period scorecard
            </div>
            <h1 className="font-display text-3xl font-bold tracking-tight">{focusedTitle}</h1>
            <div className="mt-1 text-sm text-dim">
              {(business === 'all' ? 'All businesses' : businesses.find((b) => b.id === business)?.name ?? business)} · vs prior month and prior year
            </div>
          </div>
          <div className="flex items-center gap-2">
            <RangePicker from={from} to={to} onChange={({ from: f, to: t }) => { setFrom(f); setTo(t); }} />
            <Button variant="outline" size="sm" onClick={() => exportCashFlowCsv(summary)}>
              <Download className="h-3.5 w-3.5" />
              Export
            </Button>
          </div>
        </div>

        {/* Account filter chips */}
        {visibleAccounts.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-ink2/10 bg-paper p-2 shadow-sm">
            <span className="px-1 font-mono text-[10px] font-medium uppercase tracking-wider text-dim">
              Accounts
            </span>
            <FilterChip
              active={accountIds.length === 0}
              onClick={() => setAccountIds([])}
            >
              All
            </FilterChip>
            {visibleAccounts.map((account) => (
              <FilterChip
                key={account.id}
                active={accountIds.includes(account.id)}
                muted={!account.enabled}
                onClick={() => setAccountIds((current) => toggle(account.id, current))}
              >
                {accountLabel(account)}
              </FilterChip>
            ))}
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-coral/30 bg-coral/10 p-4 text-sm font-bold text-coral-ink">{error}</div>
        )}

        {/* 3-up scorecard */}
        {thisMonth ? (
          <div className="grid gap-3 lg:grid-cols-3">
            {compareCards.map((c) => <ComparisonCard key={c.label} data={c} />)}
          </div>
        ) : !loading ? (
          <Card className="p-8">
            <EmptyState title="No cash flow for this range" />
          </Card>
        ) : null}

        {/* 12-month trend chart */}
        <Card className="p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">Trend</div>
              <h2 className="font-display text-xl font-bold text-ink">12-month cash movement</h2>
            </div>
            <ChartLegend periods={periods} />
          </div>
          <CashFlowChart periods={periods} height={260} />
        </Card>

        {/* Category mix + top movers */}
        <div className="grid gap-3 lg:grid-cols-2">
          <Card className="p-4">
            <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">
              Category mix{thisMonth ? ` · ${thisMonth.label}` : ''}
            </div>
            <h3 className="mb-3 font-display text-lg font-bold text-ink">Where outflow went</h3>
            {categories.length === 0 ? (
              <div className="py-8 text-center text-sm text-dim">No spend categorized yet.</div>
            ) : (
              <div className="flex flex-col gap-2">
                {categories.map((category, index) => {
                  const max = categories[0].amountCents ?? Math.round(categories[0].amount * 100);
                  const cents = category.amountCents ?? Math.round(category.amount * 100);
                  const width = max ? (cents / max) * 100 : 0;
                  const palette = ['#D97757', '#2A6FDB', '#1F8A5B', '#caa6f0', '#f1b6c5', '#ecd95a', '#9fc6e8', '#abc89a'];
                  return (
                    <div
                      key={`${category.name}-${index}`}
                      className="grid grid-cols-[120px_1fr_88px] items-center gap-3"
                    >
                      <span className="truncate text-xs font-bold text-ink">{category.name}</span>
                      <div className="h-3 overflow-hidden rounded-full bg-[hsl(var(--color-sunken))]">
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${width}%`, background: palette[index % palette.length] }}
                        />
                      </div>
                      <div className="text-right">
                        <div className="font-display text-sm font-bold tabular-nums">
                          {fmtCompactCents(cents)}
                        </div>
                        <Delta label={category.delta} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <Card className="p-4">
            <div className="mb-3 flex items-start justify-between">
              <div>
                <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">
                  Top movers{thisMonth ? ` · ${thisMonth.label}` : ''}
                </div>
                <h3 className="font-display text-lg font-bold text-ink">By business</h3>
              </div>
            </div>
            <BusinessBreakdown periods={periods} />
          </Card>
        </div>
      </div>
    </AppShell>
  );
}

interface ComparisonCardData {
  label: string;
  sub: string;
  inflowCents: number;
  outflowCents: number;
  netCents: number;
  current: boolean;
  moDelta?: number;
  yoyDelta?: number;
}

function ComparisonCard({ data }: { data: ComparisonCardData }) {
  const current = data.current;
  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border shadow-sm',
        current ? 'border-ink2/30 bg-ink text-paper' : 'border-ink2/10 bg-paper',
      )}
    >
      <div className={cn('px-4 py-3', current ? 'border-b border-paper/15' : 'border-b border-ink2/10')}>
        <div className={cn('font-mono text-[10px] uppercase tracking-wider', current ? 'text-paper/60' : 'text-dim')}>
          {data.label}
        </div>
        <div
          className={cn(
            'font-display text-2xl font-bold tabular-nums',
            data.netCents < 0 && !current && 'text-coral-ink',
          )}
        >
          {fmtCompactCents(data.netCents, { signed: true })}
        </div>
        <div className={cn('text-xs', current ? 'text-paper/60' : 'text-dim')}>{data.sub}</div>
      </div>
      <div className={cn('grid grid-cols-2 divide-x', current ? 'divide-paper/15' : 'divide-ink2/10')}>
        <div className="px-4 py-3">
          <div className={cn('font-mono text-[10px] uppercase tracking-wider', current ? 'text-paper/60' : 'text-dim')}>
            Inflow
          </div>
          <div className={cn('font-bold tabular-nums', current ? 'text-paper' : 'text-sage-ink')}>
            +{fmtCompactCents(data.inflowCents)}
          </div>
        </div>
        <div className="px-4 py-3">
          <div className={cn('font-mono text-[10px] uppercase tracking-wider', current ? 'text-paper/60' : 'text-dim')}>
            Outflow
          </div>
          <div className={cn('font-bold tabular-nums', current ? 'text-paper' : 'text-ink')}>
            −{fmtCompactCents(data.outflowCents)}
          </div>
        </div>
      </div>
      {current && (
        <div className="grid grid-cols-2 divide-x divide-paper/15 border-t border-paper/15">
          <div className="px-4 py-3">
            <div className="font-mono text-[10px] uppercase tracking-wider text-paper/60">vs Last month</div>
            <DeltaPct value={data.moDelta ?? 0} />
          </div>
          <div className="px-4 py-3">
            <div className="font-mono text-[10px] uppercase tracking-wider text-paper/60">vs Last year</div>
            <DeltaPct value={data.yoyDelta ?? 0} />
          </div>
        </div>
      )}
    </div>
  );
}

function ChartLegend({ periods }: { periods: CashFlowPeriod[] }) {
  const colors = new Map<string, { name: string; color: string }>();
  periods.forEach((period) => {
    period.businessBreakdown.forEach((row) => {
      if (!colors.has(row.businessId)) {
        colors.set(row.businessId, { name: row.businessName, color: row.color });
      }
    });
  });
  if (colors.size === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs font-medium text-dim">
      {[...colors.values()].map((entry) => (
        <span key={entry.name} className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: entry.color }} />
          {entry.name}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <span className="h-px w-4 bg-ink" />
        Net
      </span>
    </div>
  );
}

function CashFlowChart({ periods, height = 240 }: { periods: CashFlowPeriod[]; height?: number }) {
  if (periods.length === 0) {
    return (
      <div className="flex items-center justify-center text-sm text-dim" style={{ height }}>
        No periods to chart.
      </div>
    );
  }
  const max = Math.max(...periods.map((p) => Math.max(p.outflowCents, p.inflowCents)), 1) * 1.05;
  const netMax = Math.max(...periods.map((p) => Math.abs(p.netCents)), 1);
  const barW = 100 / (periods.length * 2);

  const netPts = periods.map((period, index) => {
    const x = (index + 0.5) * (100 / periods.length);
    const y = 50 - (period.netCents / netMax) * 40;
    return [x, y] as const;
  });
  const netPath = netPts.map(([x, y], index) => (index === 0 ? `M${x},${y}` : `L${x},${y}`)).join(' ');

  return (
    <div className="relative" style={{ height }}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
        <line x1="0" y1="50" x2="100" y2="50" stroke="hsl(45 14% 7% / 0.15)" strokeWidth="0.15" />
        {[10, 30, 70, 90].map((y) => (
          <line key={y} x1="0" y1={y} x2="100" y2={y} stroke="hsl(45 14% 7% / 0.04)" strokeWidth="0.1" />
        ))}

        {periods.map((period, index) => {
          const cx = (index + 0.5) * (100 / periods.length);
          // Outflow stack down (negative direction)
          let outAcc = 0;
          // Inflow stack up
          let inAcc = 0;
          return (
            <g key={period.label}>
              {period.businessBreakdown.map((row) => {
                const outH = period.outflowCents ? (row.outflowCents / max) * 45 : 0;
                const inH = period.inflowCents ? (row.inflowCents / max) * 45 : 0;
                const elements: JSX.Element[] = [];
                if (outH > 0) {
                  const y = 50 + outAcc;
                  elements.push(
                    <rect
                      key={`out-${row.businessId}`}
                      x={cx - barW * 0.7}
                      y={y}
                      width={barW * 1.4}
                      height={outH}
                      fill={row.color}
                      opacity="0.85"
                    />,
                  );
                  outAcc += outH;
                }
                if (inH > 0) {
                  inAcc += inH;
                  const y = 50 - inAcc;
                  elements.push(
                    <rect
                      key={`in-${row.businessId}`}
                      x={cx - barW * 0.7}
                      y={y}
                      width={barW * 1.4}
                      height={inH}
                      fill={row.color}
                      opacity="0.55"
                    />,
                  );
                }
                return elements;
              })}
            </g>
          );
        })}

        <path d={netPath} fill="none" stroke="hsl(45 14% 7%)" strokeWidth="0.4" strokeLinejoin="round" />
        {netPts.map(([x, y], index) => (
          <circle
            key={index}
            cx={x}
            cy={y}
            r="0.7"
            fill="hsl(var(--color-paper))"
            stroke="hsl(45 14% 7%)"
            strokeWidth="0.3"
          />
        ))}
      </svg>
      <div className="absolute inset-x-0 bottom-0 flex justify-around pt-2">
        {periods.map((period) => (
          <div
            key={period.label}
            className="text-center font-mono text-[10px] font-medium uppercase tracking-wider text-dim"
          >
            {period.label}
          </div>
        ))}
      </div>
    </div>
  );
}

function BusinessBreakdown({ periods }: { periods: CashFlowPeriod[] }) {
  const latest = periods.at(-1);
  if (!latest || latest.businessBreakdown.length === 0) {
    return <div className="py-6 text-center text-sm text-dim">No business breakdown.</div>;
  }
  const sorted = [...latest.businessBreakdown].sort((a, b) => b.netCents - a.netCents);
  return (
    <div className="flex flex-col gap-2">
      {sorted.map((row) => {
        const positive = row.netCents >= 0;
        return (
          <div key={row.businessId} className="flex items-center gap-3 rounded-lg bg-[hsl(var(--color-sunken))] p-3">
            <div
              className="flex h-9 w-9 items-center justify-center rounded-lg"
              style={{ background: `${row.color}22` }}
            >
              {positive ? (
                <TrendingUp className="h-4 w-4" style={{ color: row.color }} />
              ) : (
                <TrendingDown className="h-4 w-4" style={{ color: row.color }} />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-bold text-ink">{row.businessName}</div>
              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-dim">
                <span className="text-sage-ink">+{fmtCompactCents(row.inflowCents)}</span>
                <span>·</span>
                <span>−{fmtCompactCents(row.outflowCents)}</span>
              </div>
            </div>
            <div className="text-right">
              <div
                className={cn(
                  'font-display text-sm font-bold tabular-nums',
                  positive ? 'text-sage-ink' : 'text-coral-ink',
                )}
              >
                {fmtCompactCents(row.netCents, { signed: true })}
              </div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-dim">Net</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function FilterChip({
  active,
  muted,
  children,
  onClick,
}: {
  active: boolean;
  muted?: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full border px-2.5 py-1 text-xs font-bold transition-colors',
        active ? 'border-ink bg-ink text-lemon' : 'border-ink2/20 bg-cream/70 text-ink hover:border-ink2/40',
        muted && 'opacity-60',
      )}
    >
      {children}
    </button>
  );
}

function DeltaPct({ value }: { value: number }) {
  const positive = value >= 0;
  const Icon = positive ? ChevronUp : ChevronDown;
  return (
    <span className={cn('inline-flex items-center gap-1 font-bold tabular-nums', positive ? 'text-sage' : 'text-coral')}>
      <Icon className="h-3.5 w-3.5" />
      {value}%
    </span>
  );
}

function Delta({ label }: { label?: string }) {
  if (!label) return null;
  const positive = !label.startsWith('-');
  const Icon = positive ? ChevronUp : ChevronDown;
  return (
    <span
      className={cn(
        'inline-flex items-center justify-end gap-1 font-bold tabular-nums text-[10px]',
        positive ? 'text-sage-ink' : 'text-coral-ink',
      )}
    >
      <Icon className="h-3 w-3" />
      {label.replace(/^[+-]/, '')}
    </span>
  );
}

function RangePicker({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (range: { from: string; to: string }) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 rounded-full border border-ink2/15 bg-paper px-2 py-1 text-xs">
      <input
        type="date"
        value={from}
        onChange={(event) => onChange({ from: event.target.value, to })}
        className="h-7 rounded-md border-transparent bg-transparent px-2 text-xs"
      />
      <span className="text-dim">→</span>
      <input
        type="date"
        value={to}
        onChange={(event) => onChange({ from, to: event.target.value })}
        className="h-7 rounded-md border-transparent bg-transparent px-2 text-xs"
      />
    </div>
  );
}

function exportCashFlowCsv(summary: CashFlowSummary) {
  const headers = ['period', 'from', 'to', 'inflow_cents', 'outflow_cents', 'transfer_cents', 'net_cents', 'prev_inflow_cents', 'prev_outflow_cents', 'prev_net_cents', 'net_delta_pct'];
  const lines = [headers.join(',')];
  summary.periods.forEach((period) => {
    lines.push([
      period.label,
      period.from,
      period.to,
      period.inflowCents,
      period.outflowCents,
      period.transferCents,
      period.netCents,
      period.previousInflowCents,
      period.previousOutflowCents,
      period.previousNetCents,
      period.netDeltaPct,
    ].join(','));
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `cash-flow-${summary.from}-to-${summary.to}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function fmtCompactCents(cents: number, options: { signed?: boolean } = {}): string {
  const amount = cents / 100;
  const absAmount = Math.abs(amount);
  const sign = options.signed ? (amount >= 0 ? '+' : '−') : amount < 0 ? '−' : '';
  if (absAmount >= 1000) {
    return `${sign}$${new Intl.NumberFormat('en-US', {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(absAmount)}`;
  }
  return `${sign}$${absAmount.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function prevYearLabel(label: string): string {
  // Best-effort "May 25 → May 24" style stub; backend returns labels like "May 26".
  const match = label.match(/^(\w+) ?(\d{2,4})?$/);
  if (!match) return label;
  const month = match[1];
  const year = match[2];
  if (!year) return `${month} (prior year)`;
  const fullYear = year.length === 2 ? 2000 + Number(year) : Number(year);
  return `${month} ${String(fullYear - 1).slice(-2)}`;
}

function toggle<T>(value: T, values: T[]): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaultFrom(): string {
  const start = new Date();
  start.setMonth(start.getMonth() - 11);
  start.setDate(1);
  return start.toISOString().slice(0, 10);
}
