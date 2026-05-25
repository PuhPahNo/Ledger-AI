import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { CalendarDays, ChevronDown, ChevronUp } from 'lucide-react';
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
          </div>
          <Button variant="outline" onClick={focusMarchComparison}>
            <CalendarDays className="h-4 w-4" />
            March 2026 vs 2025
          </Button>
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <Metric label="Inflow" cents={summary.totals.inflowCents} tone="positive" />
          <Metric label="Outflow" cents={summary.totals.outflowCents} />
          <Metric label="Net cash" cents={summary.totals.netCents} signed tone={summary.totals.netCents >= 0 ? 'positive' : 'warning'} />
          <Metric label="YoY net change" cents={summary.totals.netDeltaCents} signed tone={summary.totals.netDeltaCents >= 0 ? 'positive' : 'warning'} />
          <Metric label="Transfers" cents={summary.totals.transferCents} tone="muted" />
        </div>

        <div className="grid gap-3 rounded-xl border border-ink2/10 bg-paper p-3 shadow-sm xl:grid-cols-[220px_1fr_160px_160px_auto]">
          <div className="grid gap-1.5">
            <Label>View</Label>
            <ToggleGroup type="single" value={group} onValueChange={(value) => value && setGroup(value as CashFlowGroup)}>
              <ToggleGroupItem value="month">Monthly</ToggleGroupItem>
              <ToggleGroupItem value="year">Annual</ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div className="grid gap-1.5">
            <Label>Accounts</Label>
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
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="cash-flow-from">From</Label>
            <Input id="cash-flow-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="cash-flow-to">To</Label>
            <Input id="cash-flow-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </div>
          <label className="flex items-end gap-2 pb-2 text-sm font-bold">
            <Switch checked={includeTransfers} onCheckedChange={setIncludeTransfers} />
            Include transfers
          </label>
        </div>

        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_460px]">
          <div className="rounded-xl border border-ink2/10 bg-paper p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <div className="font-display text-lg font-bold">Cash movement by period</div>
              <Badge variant="muted">{includeTransfers ? 'All movement' : 'Operating only'}</Badge>
            </div>
            {error ? (
              <div className="text-sm font-bold text-coral-ink">{error}</div>
            ) : (
              <div className="grid gap-3">
                {summary.periods.map((period) => (
                  <PeriodBars key={`${period.from}-${period.to}`} period={period} maxInflow={maxInflow} maxOutflow={maxOutflow} />
                ))}
                {!loading && summary.periods.length === 0 && <div className="py-8 text-center text-sm text-dim">No cash flow for this range.</div>}
                {loading && <div className="py-8 text-center text-sm text-dim">Loading cash flow...</div>}
              </div>
            )}
          </div>

          <div className="overflow-hidden rounded-xl border border-ink2/10 bg-paper shadow-sm">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Period</TableHead>
                  <TableHead className="text-right">In</TableHead>
                  <TableHead className="text-right">Out</TableHead>
                  <TableHead className="text-right">Net</TableHead>
                  <TableHead className="text-right">YoY</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.periods.map((period) => (
                  <TableRow key={period.label}>
                    <TableCell className="font-bold">{period.label}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCents(period.inflowCents)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCents(period.outflowCents)}</TableCell>
                    <TableCell className={cn('text-right font-bold tabular-nums', period.netCents >= 0 ? 'text-sage-ink' : 'text-coral-ink')}>
                      {formatCents(period.netCents, true)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Delta value={period.netDeltaCents} pct={period.netDeltaPct} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>
    </div>
  );
}

function PeriodBars({ period, maxInflow, maxOutflow }: { period: CashFlowPeriod; maxInflow: number; maxOutflow: number }) {
  return (
    <div className="grid gap-2 rounded-lg bg-[hsl(var(--color-sunken))] p-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="font-bold">{period.label}</div>
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
      <div className="h-3 overflow-hidden rounded-full bg-paper">
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

function Metric({
  label,
  cents,
  signed,
  tone = 'default',
}: {
  label: string;
  cents: number;
  signed?: boolean;
  tone?: 'default' | 'positive' | 'warning' | 'muted';
}) {
  return (
    <div className={cn(
      'rounded-lg border px-3 py-2 shadow-sm',
      tone === 'positive' && 'border-sage/40 bg-sage/10 text-sage-ink',
      tone === 'warning' && 'border-coral/40 bg-coral/10 text-coral-ink',
      tone === 'muted' && 'border-ink2/10 bg-paper text-dim',
      tone === 'default' && 'border-ink2/10 bg-paper',
    )}>
      <div className="font-mono text-[10px] uppercase tracking-wider text-dim">{label}</div>
      <div className="font-display text-xl font-bold tabular-nums">{formatCents(cents, signed)}</div>
    </div>
  );
}

function Delta({ value, pct, compact }: { value: number; pct: number; compact?: boolean }) {
  const positive = value >= 0;
  const Icon = positive ? ChevronUp : ChevronDown;
  return (
    <span className={cn('inline-flex items-center justify-end gap-1 font-bold tabular-nums', positive ? 'text-sage-ink' : 'text-coral-ink')}>
      <Icon className="h-3.5 w-3.5" />
      {compact ? formatCents(value, true) : `${formatCents(value, true)} (${pct}%)`}
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

function toggle<T>(value: T, values: T[]): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function formatCents(cents: number, signed = false): string {
  const amount = cents / 100;
  return signed ? fmt$(amount) : fmt$(Math.abs(amount));
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
