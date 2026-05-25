import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { BarChart3, CalendarDays, ChevronDown, ChevronUp } from 'lucide-react';
import { getCashFlow, listAccounts, listBusinesses, uploadReceipt } from '@/api';
import type { Account, Business, CashFlowGroup, CashFlowPeriod, CashFlowSummary, CurrentUser } from '@/types/domain';
import type { AppView } from '@/types/navigation';
import { accountLabel } from '@/lib/account';
import { fmt$ } from '@/lib/format';
import { useToast } from '@/hooks/useToast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '@/lib/cn';
import { HeaderBar } from './HeaderBar';

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
  const [group, setGroup] = useState<CashFlowGroup>('month');
  const [includeTransfers, setIncludeTransfers] = useState(false);
  const [from, setFrom] = useState(defaultFrom());
  const [to, setTo] = useState(today());
  const [summary, setSummary] = useState<CashFlowSummary>(emptyCashFlow);
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
      group,
      includeTransfers,
      biz: business,
      accountIds,
    })
      .then(setSummary)
      .catch((loadError: Error) => setError(loadError.message))
      .finally(() => setLoading(false));
  }, [accountIds, business, from, group, includeTransfers, refreshKey, to]);

  const visibleAccounts = business === 'all' ? accounts : accounts.filter((account) => account.biz === business);
  const selectedBusinessDbId = business === 'all' ? undefined : businesses.find((item) => item.id === business)?.dbId;
  const maxInflow = Math.max(...summary.periods.map((period) => period.inflowCents), 1);
  const maxOutflow = Math.max(...summary.periods.map((period) => period.outflowCents), 1);
  const displayPeriods = [...summary.periods].reverse();
  const selectedBusinessName = business === 'all' ? 'All businesses' : businesses.find((item) => item.id === business)?.name ?? business;
  const modeLabel = includeTransfers ? 'All cash movement' : 'Operating cash flow';

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

  const focusMarchComparison = () => {
    setGroup('month');
    setFrom('2026-03-01');
    setTo('2026-03-31');
  };

  return (
    <div className="min-h-screen bg-bg text-ink">
      <div className="mx-auto flex max-w-[1500px] flex-col gap-4 p-4">
        <HeaderBar
          onUploadReceipt={handleUpload}
          currentView="cash-flow"
          onViewChange={onViewChange}
          onLogout={onLogout}
          user={user}
          businesses={businesses}
          selectedBusiness={business}
          onBusinessChange={(value) => {
            setBusiness(value);
            setAccountIds([]);
          }}
        />

        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">Cash-basis reporting</div>
            <h1 className="font-display text-3xl font-bold tracking-tight">Inflow vs outflow</h1>
            <div className="mt-1 text-sm text-dim">{selectedBusinessName} · {summary.from || from} to {summary.to || to}</div>
          </div>
          <Button variant="outline" onClick={focusMarchComparison} className="w-full sm:w-auto">
            <CalendarDays className="h-4 w-4" />
            <span className="hidden sm:inline">March 2026 vs 2025</span>
            <span className="sm:hidden">Compare March</span>
          </Button>
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <Metric label="Inflow" cents={summary.totals.inflowCents} tone="positive" detail="Cash received" />
          <Metric label="Outflow" cents={summary.totals.outflowCents} detail="Operating spend" />
          <Metric label="Net cash" cents={summary.totals.netCents} signed tone={summary.totals.netCents >= 0 ? 'positive' : 'warning'} detail={modeLabel} />
          <Metric label="YoY net change" cents={summary.totals.netDeltaCents} signed tone={summary.totals.netDeltaCents >= 0 ? 'positive' : 'warning'} detail={`${summary.totals.netDeltaPct}% vs prior year`} />
          <Metric label="Transfers" cents={summary.totals.transferCents} tone="muted" detail={includeTransfers ? 'Included' : 'Excluded by default'} />
        </div>

        <div className="grid gap-3 rounded-xl border border-ink2/10 bg-paper p-3 shadow-sm xl:grid-cols-[220px_minmax(280px,1fr)_160px_160px_auto]">
          <Field label="View">
            <ToggleGroup type="single" value={group} onValueChange={(value) => value && setGroup(value as CashFlowGroup)}>
              <ToggleGroupItem value="month">Monthly</ToggleGroupItem>
              <ToggleGroupItem value="year">Annual</ToggleGroupItem>
            </ToggleGroup>
          </Field>
          <Field label="Accounts">
            <div className="flex flex-wrap gap-1.5">
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
              {visibleAccounts.length === 0 && <span className="text-sm text-dim">No accounts</span>}
            </div>
          </Field>
          <Field label="From">
            <Input id="cash-flow-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </Field>
          <Field label="To">
            <Input id="cash-flow-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </Field>
          <label className="flex items-end gap-2 pb-2 text-sm font-bold">
            <Switch checked={includeTransfers} onCheckedChange={setIncludeTransfers} />
            Include transfers
          </label>
        </div>

        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_430px]">
          <section className="overflow-hidden rounded-xl border border-ink2/10 bg-paper shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink2/10 px-4 py-3">
              <div>
                <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">Trend</div>
                <h2 className="font-display text-xl font-bold">Cash movement</h2>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="muted">{group === 'month' ? 'Monthly' : 'Annual'}</Badge>
                <Badge variant={includeTransfers ? 'warning' : 'secondary'}>{modeLabel}</Badge>
              </div>
            </div>
            <BusinessLegend periods={displayPeriods} />
            {error ? (
              <div className="p-4">
                <div className="rounded-lg border border-coral/30 bg-coral/10 p-4 text-sm font-bold text-coral-ink">{error}</div>
              </div>
            ) : (
              <div className="grid gap-3 p-4">
                {displayPeriods.map((period) => (
                  <PeriodBars key={`${period.from}-${period.to}`} period={period} maxInflow={maxInflow} maxOutflow={maxOutflow} />
                ))}
                {!loading && displayPeriods.length === 0 && <EmptyState title="No cash flow for this range" icon={<BarChart3 className="h-5 w-5" />} />}
                {loading && <div className="py-8 text-center text-sm text-dim">Loading cash flow...</div>}
              </div>
            )}
          </section>

          <section className="overflow-hidden rounded-xl border border-ink2/10 bg-paper shadow-sm">
            <div className="border-b border-ink2/10 px-4 py-3">
              <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">Detail</div>
              <h2 className="font-display text-xl font-bold">Period detail</h2>
            </div>
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20">Period</TableHead>
                  <TableHead className="w-20 text-right">In</TableHead>
                  <TableHead className="w-20 text-right">Out</TableHead>
                  <TableHead className="w-20 text-right">Net</TableHead>
                  <TableHead className="w-20 text-right">YoY</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {displayPeriods.map((period) => (
                  <TableRow key={period.label}>
                    <TableCell className="font-bold">{period.label}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCents(period.inflowCents)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCents(period.outflowCents)}</TableCell>
                    <TableCell className={cn('text-right font-bold tabular-nums', period.netCents >= 0 ? 'text-sage-ink' : 'text-coral-ink')}>
                      {formatCents(period.netCents, true)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Delta value={period.netDeltaCents} pct={period.netDeltaPct} compact />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {!loading && displayPeriods.length === 0 && (
              <div className="p-4">
                <EmptyState title="No periods to show" icon={<BarChart3 className="h-5 w-5" />} />
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function PeriodBars({ period, maxInflow, maxOutflow }: { period: CashFlowPeriod; maxInflow: number; maxOutflow: number }) {
  return (
    <div className="grid gap-3 rounded-lg border border-ink2/10 bg-[hsl(var(--color-sunken))] p-3">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="font-bold">{period.label}</div>
          <div className="text-xs text-dim">{period.from} to {period.to}</div>
        </div>
        <div className="text-sm text-dim">
          Net <span className={cn('font-bold tabular-nums', period.netCents >= 0 ? 'text-sage-ink' : 'text-coral-ink')}>{formatCents(period.netCents, true)}</span>
        </div>
      </div>
      <StackedBar label="In" cents={period.inflowCents} max={maxInflow} businesses={period.businessBreakdown} mode="inflow" />
      <StackedBar label="Out" cents={period.outflowCents} max={maxOutflow} businesses={period.businessBreakdown} mode="outflow" />
      <div className="flex items-center justify-between text-xs text-dim">
        <span>Prior year net {formatCents(period.previousNetCents, true)}</span>
        <Delta value={period.netDeltaCents} pct={period.netDeltaPct} compact />
      </div>
    </div>
  );
}

function StackedBar({
  label,
  cents,
  max,
  businesses,
  mode,
}: {
  label: string;
  cents: number;
  max: number;
  businesses: CashFlowPeriod['businessBreakdown'];
  mode: 'inflow' | 'outflow';
}) {
  const totalWidth = Math.max(3, (cents / max) * 100);
  return (
    <div className="grid grid-cols-[34px_minmax(0,1fr)_92px] items-center gap-2 text-xs">
      <span className="font-bold text-dim">{label}</span>
      <div className="h-3 overflow-hidden rounded-full bg-paper ring-1 ring-ink2/10">
        <div className="flex h-full overflow-hidden rounded-full" style={{ width: `${totalWidth}%` }}>
          {businesses.map((business) => {
            const value = mode === 'inflow' ? business.inflowCents : business.outflowCents;
            if (!value || !cents) return null;
            return (
              <div
                key={business.businessId}
                title={`${business.businessName}: ${formatCents(value)}`}
                style={{ width: `${(value / cents) * 100}%`, background: business.color }}
              />
            );
          })}
        </div>
      </div>
      <span className="text-right font-bold tabular-nums">{formatCents(cents)}</span>
    </div>
  );
}

function BusinessLegend({ periods }: { periods: CashFlowPeriod[] }) {
  const businesses = new Map<string, { name: string; color: string }>();
  periods.forEach((period) => {
    period.businessBreakdown.forEach((business) => {
      if (!businesses.has(business.businessId)) {
        businesses.set(business.businessId, { name: business.businessName, color: business.color });
      }
    });
  });

  if (businesses.size === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 border-b border-ink2/10 px-4 py-3">
      {[...businesses.entries()].map(([id, business]) => (
        <span key={id} className="inline-flex items-center gap-1.5 rounded-full bg-cream px-2.5 py-1 text-xs font-bold text-ink">
          <span className="h-2 w-2 rounded-full" style={{ background: business.color }} />
          {business.name}
        </span>
      ))}
    </div>
  );
}

function Metric({
  label,
  cents,
  signed,
  tone = 'default',
  detail,
}: {
  label: string;
  cents: number;
  signed?: boolean;
  tone?: 'default' | 'positive' | 'warning' | 'muted';
  detail?: string;
}) {
  return (
    <div className={cn(
      'min-h-[86px] rounded-lg border px-3 py-2.5 shadow-sm',
      tone === 'positive' && 'border-sage/40 bg-sage/10 text-sage-ink',
      tone === 'warning' && 'border-coral/40 bg-coral/10 text-coral-ink',
      tone === 'muted' && 'border-ink2/10 bg-paper text-dim',
      tone === 'default' && 'border-ink2/10 bg-paper',
    )}>
      <div className="font-mono text-[10px] uppercase tracking-wider text-dim">{label}</div>
      <div className="font-display text-xl font-bold tabular-nums">{formatCents(cents, signed)}</div>
      {detail && <div className="mt-1 truncate text-xs font-medium text-dim">{detail}</div>}
    </div>
  );
}

function Delta({ value, pct, compact }: { value: number; pct: number; compact?: boolean }) {
  const positive = value >= 0;
  const Icon = positive ? ChevronUp : ChevronDown;
  return (
    <span className={cn('inline-flex items-center justify-end gap-1 font-bold tabular-nums', positive ? 'text-sage-ink' : 'text-coral-ink')}>
      <Icon className="h-3.5 w-3.5" />
      {compact ? formatCompactCents(value, true) : `${formatCents(value, true)} (${pct}%)`}
    </span>
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

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label className="font-mono text-[10px] uppercase tracking-wider text-dim">{label}</Label>
      {children}
    </div>
  );
}

function toggle<T>(value: T, values: T[]): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function formatCents(cents: number, signed = false): string {
  const amount = cents / 100;
  return signed ? fmt$(amount) : fmt$(Math.abs(amount));
}

function formatCompactCents(cents: number, signed = false): string {
  if (Math.abs(cents) < 100_000) return formatCents(cents, signed);
  const amount = signed ? cents / 100 : Math.abs(cents / 100);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(amount);
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
