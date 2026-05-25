import { useEffect, useMemo, useState } from 'react';
import { ArrowRightLeft } from 'lucide-react';
import { getCashFlow, listAccounts, listBusinesses, uploadReceipt } from '@/api';
import type { Account, Business, CashFlowGroup, CashFlowPeriod, CashFlowSummary, CurrentUser } from '@/types/domain';
import type { AppView } from '@/types/navigation';
import { accountLabel } from '@/lib/account';
import { fmt$, fmtPctDelta } from '@/lib/format';
import { useToast } from '@/hooks/useToast';
import { HeaderBar } from './HeaderBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
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
  const [summary, setSummary] = useState<CashFlowSummary>(emptyCashFlow);
  const [business, setBusiness] = useState('all');
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [group, setGroup] = useState<CashFlowGroup>('month');
  const [includeTransfers, setIncludeTransfers] = useState(false);
  const [from, setFrom] = useState(() => `${new Date().getFullYear()}-01-01`);
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [query, setQuery] = useState('');
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
  const maxOutflow = Math.max(...summary.periods.map((period) => period.outflowCents), 1);
  const filteredPeriods = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return summary.periods;
    return summary.periods.filter((period) => period.label.toLowerCase().includes(needle));
  }, [query, summary.periods]);

  const setMarchComparison = () => {
    const year = new Date().getFullYear();
    setGroup('month');
    setFrom(`${year}-03-01`);
    setTo(`${year}-03-31`);
  };

  const handleUpload = async (file: File) => {
    try {
      const selectedBusiness = businesses.find((item) => item.id === business);
      await uploadReceipt(file, selectedBusiness?.dbId);
      toast({ variant: 'success', title: 'Receipt queued' });
      setRefreshKey((key) => key + 1);
    } catch (uploadError) {
      toast({
        variant: 'destructive',
        title: 'Upload failed',
        description: uploadError instanceof Error ? uploadError.message : 'Try again.',
      });
    }
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
          query={query}
          onQueryChange={setQuery}
        />

        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">Cash basis</div>
            <h1 className="font-display text-3xl font-bold tracking-tight">Cash Flow</h1>
          </div>
          <Button variant="outline" onClick={setMarchComparison}>
            <ArrowRightLeft className="h-4 w-4" />
            March YoY
          </Button>
        </div>

        <div className="grid gap-3 md:grid-cols-5">
          <Metric label="Inflow" value={fmt$(summary.totals.inflowCents / 100)} tone="positive" />
          <Metric label="Outflow" value={fmt$(summary.totals.outflowCents / 100)} />
          <Metric label="Net" value={fmt$(summary.totals.netCents / 100)} tone={summary.totals.netCents >= 0 ? 'positive' : 'warning'} />
          <Metric label="Prior Net" value={fmt$(summary.totals.previousNetCents / 100)} tone="muted" />
          <Metric label="YoY Net" value={`${fmt$(summary.totals.netDeltaCents / 100)} ${fmtPctDelta(summary.totals.netDeltaPct)}`} tone={summary.totals.netDeltaCents >= 0 ? 'positive' : 'warning'} />
        </div>

        <div className="grid gap-3 rounded-xl border border-ink2/10 bg-paper p-3 shadow-sm lg:grid-cols-[190px_190px_1fr_auto]">
          <Field label="Business">
            <Select
              value={business}
              onValueChange={(value) => {
                setBusiness(value);
                setAccountIds([]);
              }}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All businesses</SelectItem>
                {businesses.map((item) => (
                  <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Group">
            <ToggleGroup type="single" value={group} onValueChange={(value) => value && setGroup(value as CashFlowGroup)}>
              <ToggleGroupItem value="month">Monthly</ToggleGroupItem>
              <ToggleGroupItem value="year">Annual</ToggleGroupItem>
            </ToggleGroup>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="From">
              <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
            </Field>
            <Field label="To">
              <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
            </Field>
          </div>
          <label className="flex items-end gap-2 pb-2 text-sm font-bold">
            <Switch checked={includeTransfers} onCheckedChange={setIncludeTransfers} />
            All movement
          </label>

          <div className="lg:col-span-4">
            <FilterGroup label="Accounts">
              {visibleAccounts.length ? visibleAccounts.map((account) => (
                <FilterChip
                  key={account.id}
                  active={accountIds.includes(account.id)}
                  muted={!account.enabled}
                  onClick={() => setAccountIds((current) => toggle(account.id, current))}
                >
                  {accountLabel(account)}
                  {account.mask ? ` ${account.mask}` : ''}
                </FilterChip>
              )) : <span className="text-xs text-dim">No accounts match this business.</span>}
            </FilterGroup>
          </div>
        </div>

        <div className="grid gap-3">
          {filteredPeriods.map((period) => (
            <CashFlowRow key={`${period.from}-${period.to}`} period={period} maxOutflow={maxOutflow} />
          ))}
          {!loading && !filteredPeriods.length && !error && (
            <div className="rounded-xl border border-ink2/10 bg-paper p-8 text-center text-sm text-dim">
              No cash-flow periods match the current filters.
            </div>
          )}
          {loading && <div className="rounded-xl border border-ink2/10 bg-paper p-6 text-center text-sm text-dim">Loading cash flow...</div>}
          {error && <div className="rounded-xl border border-coral/30 bg-coral/10 p-4 text-sm font-bold text-coral-ink">{error}</div>}
        </div>

        <div className="overflow-hidden rounded-xl border border-ink2/10 bg-paper shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Period</TableHead>
                <TableHead className="text-right">Inflow</TableHead>
                <TableHead className="text-right">Outflow</TableHead>
                <TableHead className="text-right">Transfers</TableHead>
                <TableHead className="text-right">Net</TableHead>
                <TableHead className="text-right">Prior Net</TableHead>
                <TableHead className="text-right">YoY</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredPeriods.map((period) => (
                <TableRow key={period.label}>
                  <TableCell className="font-bold">{period.label}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt$(period.inflowCents / 100)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt$(period.outflowCents / 100)}</TableCell>
                  <TableCell className="text-right tabular-nums text-dim">{fmt$(period.transferCents / 100)}</TableCell>
                  <TableCell className={cn('text-right font-bold tabular-nums', period.netCents >= 0 ? 'text-sage-ink' : 'text-coral-ink')}>
                    {fmt$(period.netCents / 100)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{fmt$(period.previousNetCents / 100)}</TableCell>
                  <TableCell className={cn('text-right font-bold tabular-nums', period.netDeltaCents >= 0 ? 'text-sage-ink' : 'text-coral-ink')}>
                    {fmtPctDelta(period.netDeltaPct)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}

function CashFlowRow({ period, maxOutflow }: { period: CashFlowPeriod; maxOutflow: number }) {
  return (
    <div className="grid gap-3 rounded-xl border border-ink2/10 bg-paper p-3 shadow-sm lg:grid-cols-[160px_1fr_340px]">
      <div>
        <div className="font-display text-lg font-bold">{period.label}</div>
        <div className="text-xs text-dim">{period.from} to {period.to}</div>
      </div>
      <div className="grid content-center gap-2">
        <div className="h-5 overflow-hidden rounded-full bg-[hsl(var(--color-sunken))]">
          <div className="flex h-full" style={{ width: `${Math.max(3, (period.outflowCents / maxOutflow) * 100)}%` }}>
            {period.businessBreakdown.map((item) => (
              <div
                key={item.businessId}
                title={`${item.businessName}: ${fmt$(item.outflowCents / 100)}`}
                style={{
                  width: `${period.outflowCents > 0 ? (item.outflowCents / period.outflowCents) * 100 : 0}%`,
                  background: item.color,
                }}
              />
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 text-xs text-dim">
          {period.businessBreakdown.map((item) => (
            <span key={item.businessId} className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full" style={{ background: item.color }} />
              {item.businessName}
            </span>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 text-right">
        <SmallStat label="In" value={fmt$(period.inflowCents / 100)} />
        <SmallStat label="Out" value={fmt$(period.outflowCents / 100)} />
        <SmallStat label="Net" value={fmt$(period.netCents / 100)} tone={period.netCents >= 0 ? 'positive' : 'warning'} />
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label className="font-mono text-[10px] uppercase tracking-wider text-dim">{label}</Label>
      {children}
    </div>
  );
}

function Metric({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'positive' | 'warning' | 'muted' }) {
  return (
    <div className={cn(
      'rounded-lg border px-3 py-2 shadow-sm',
      tone === 'positive' && 'border-sage/40 bg-sage/10 text-sage-ink',
      tone === 'warning' && 'border-coral/40 bg-coral/10 text-coral-ink',
      tone === 'muted' && 'border-ink2/10 bg-paper text-dim',
      tone === 'default' && 'border-ink2/10 bg-paper',
    )}>
      <div className="font-mono text-[10px] uppercase tracking-wider text-dim">{label}</div>
      <div className="font-display text-lg font-bold tabular-nums">{value}</div>
    </div>
  );
}

function SmallStat({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'positive' | 'warning' }) {
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-wider text-dim">{label}</div>
      <div className={cn('font-display text-base font-bold tabular-nums', tone === 'positive' && 'text-sage-ink', tone === 'warning' && 'text-coral-ink')}>
        {value}
      </div>
    </div>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 font-mono text-[10px] uppercase tracking-wider text-dim">{label}</span>
      {children}
    </div>
  );
}

function FilterChip({ active, muted, children, onClick }: { active: boolean; muted?: boolean; children: React.ReactNode; onClick: () => void }) {
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
