import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Download } from 'lucide-react';
import { getCashFlow, listAccounts, listBusinesses, listCategories, uploadReceipt } from '@/api';
import type { Account, Business, CashFlowSummary, Category, CurrentUser } from '@/types/domain';
import type { AppView } from '@/types/navigation';
import { accountLabel } from '@/lib/account';
import { useToast } from '@/hooks/useToast';
import { AppShell } from './AppShell';
import {
  BusinessBreakdown,
  CashFlowChart,
  CategoryMixCard,
  ChartLegend,
  ComparisonCard,
  type ComparisonCardData,
  prevYearLabel,
} from './cash-flow/CashFlowVisuals';
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
          <CategoryMixCard categories={categories} period={thisMonth} />

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
        active ? 'border-inverse bg-inverse text-inverse-foreground' : 'border-ink2/20 bg-cream/70 text-ink hover:border-ink2/40',
        muted && 'opacity-60',
      )}
    >
      {children}
    </button>
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
