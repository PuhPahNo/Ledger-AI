import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Download, ReceiptText, Search, TrendingUp } from 'lucide-react';
import { getOwnerInsights, listAccounts, listBusinesses, uploadReceipt } from '@/api';
import type { Account, Business, CurrentUser, OwnerInsightsSummary } from '@/types/domain';
import type { AppView } from '@/types/navigation';
import { accountLabel } from '@/lib/account';
import { fmt$ } from '@/lib/format';
import { useToast } from '@/hooks/useToast';
import { HeaderBar } from './HeaderBar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/cn';

interface Props {
  user?: CurrentUser;
  onViewChange?: (view: AppView) => void;
  onLogout?: () => void;
}

const emptyInsights: OwnerInsightsSummary = {
  from: '',
  to: '',
  topPurchases: [],
  uncategorized: { count: 0, cents: 0 },
  missingReceipts: { count: 0, cents: 0 },
  transfers: { count: 0, cents: 0 },
  incomeByBusiness: [],
  closeSummary: {
    inflowCents: 0,
    outflowCents: 0,
    netCents: 0,
    transactionCount: 0,
  },
};

export function OwnerInsightsPage({ user, onViewChange, onLogout }: Props) {
  const { toast } = useToast();
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [summary, setSummary] = useState<OwnerInsightsSummary>(emptyInsights);
  const [business, setBusiness] = useState('all');
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [from, setFrom] = useState(() => `${new Date().toISOString().slice(0, 7)}-01`);
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
    getOwnerInsights({ from, to, biz: business, accountIds })
      .then(setSummary)
      .catch((loadError: Error) => setError(loadError.message))
      .finally(() => setLoading(false));
  }, [accountIds, business, from, refreshKey, to]);

  const visibleAccounts = business === 'all' ? accounts : accounts.filter((account) => account.biz === business);
  const selectedBusinessDbId = business === 'all' ? undefined : businesses.find((item) => item.id === business)?.dbId;
  const filteredPurchases = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return summary.topPurchases;
    return summary.topPurchases.filter((purchase) => [
      purchase.merchant,
      purchase.cat,
      purchase.src,
      purchase.note,
    ].filter(Boolean).join(' ').toLowerCase().includes(needle));
  }, [query, summary.topPurchases]);
  const selectedBusinessName = business === 'all' ? 'All businesses' : businesses.find((item) => item.id === business)?.name ?? business;

  const handleUpload = async (file: File) => {
    try {
      await uploadReceipt(file, selectedBusinessDbId);
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
          currentView="insights"
          onViewChange={onViewChange}
          onLogout={onLogout}
          user={user}
          query={query}
          onQueryChange={setQuery}
        />

        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">Owner review</div>
            <h1 className="font-display text-3xl font-bold tracking-tight">Insights</h1>
            <div className="mt-1 text-sm text-dim">{selectedBusinessName} · {summary.from || from} to {summary.to || to}</div>
          </div>
          <Button variant="outline" onClick={() => exportInsightsCsv(summary)} className="w-full sm:w-auto">
            <Download className="h-4 w-4" />
            CSV
          </Button>
        </div>

        <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Metric label="Inflow" value={fmt$(summary.closeSummary.inflowCents / 100)} tone="positive" detail="Cash received" />
          <Metric label="Outflow" value={fmt$(summary.closeSummary.outflowCents / 100)} detail="Operating spend" />
          <Metric label="Net" value={fmt$(summary.closeSummary.netCents / 100)} tone={summary.closeSummary.netCents >= 0 ? 'positive' : 'warning'} detail="Close position" />
          <Metric label="Uncategorized" value={fmt$(summary.uncategorized.cents / 100)} detail={`${summary.uncategorized.count} txns`} tone={summary.uncategorized.count ? 'warning' : 'muted'} />
          <Metric label="Missing receipts" value={fmt$(summary.missingReceipts.cents / 100)} detail={`${summary.missingReceipts.count} txns`} tone={summary.missingReceipts.count ? 'warning' : 'muted'} />
          <Metric label="Transfers" value={fmt$(summary.transfers.cents / 100)} detail={`${summary.transfers.count} txns`} tone="muted" />
        </div>

        <div className="grid gap-3 rounded-xl border border-ink2/10 bg-paper p-3 shadow-sm lg:grid-cols-[220px_minmax(280px,1fr)_160px_160px]">
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
            <Input id="insights-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </Field>
          <Field label="To">
            <Input id="insights-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </Field>
        </div>

        {loading && <div className="rounded-xl border border-ink2/10 bg-paper p-6 text-center text-sm text-dim">Loading insights...</div>}
        {error && <div className="rounded-xl border border-coral/30 bg-coral/10 p-4 text-sm font-bold text-coral-ink">{error}</div>}

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="overflow-hidden rounded-xl border border-ink2/10 bg-paper shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink2/10 px-4 py-3">
              <div>
                <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">Spend review</div>
                <h2 className="font-display text-xl font-bold">Top purchases</h2>
              </div>
              <Badge variant="muted">{filteredPurchases.length} rows</Badge>
            </div>
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-28">Date</TableHead>
                  <TableHead>Merchant</TableHead>
                  <TableHead className="w-40">Business</TableHead>
                  <TableHead className="w-40">Category</TableHead>
                  <TableHead className="w-32 text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredPurchases.map((purchase) => (
                  <TableRow key={purchase.id}>
                    <TableCell className="text-dim">{purchase.date}</TableCell>
                    <TableCell><div className="truncate font-bold" title={purchase.merchant}>{purchase.merchant}</div></TableCell>
                    <TableCell className="truncate">{businesses.find((item) => item.id === purchase.biz)?.name ?? purchase.biz}</TableCell>
                    <TableCell className="truncate">{purchase.cat}</TableCell>
                    <TableCell className="text-right font-display font-bold tabular-nums">{fmt$(Math.abs(purchase.amount))}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {!loading && !filteredPurchases.length && (
              <div className="p-4">
                <EmptyState title="No purchases match these filters" icon={<Search className="h-5 w-5" />} />
              </div>
            )}
          </div>

          <div className="grid gap-4">
            <section className="rounded-xl border border-ink2/10 bg-paper p-4 shadow-sm">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">Income</div>
                  <h2 className="font-display text-xl font-bold">By business</h2>
                </div>
                <TrendingUp className="h-5 w-5 text-dim" />
              </div>
              <div className="mt-3 grid gap-2">
                {summary.incomeByBusiness.map((row) => (
                  <div key={row.businessId} className="grid grid-cols-[1fr_auto] items-center gap-3 rounded-lg bg-[hsl(var(--color-sunken))] p-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-bold">{row.businessName}</div>
                      <div className="mt-1 h-2 overflow-hidden rounded-full bg-paper ring-1 ring-ink2/10">
                        <div className="h-full rounded-full" style={{ width: `${incomeWidth(row.cents, summary.incomeByBusiness)}%`, background: row.color }} />
                      </div>
                      <div className="mt-1 text-xs text-dim">{row.count} deposits</div>
                    </div>
                    <div className="text-right font-display font-bold tabular-nums">{fmt$(row.cents / 100)}</div>
                  </div>
                ))}
                {!summary.incomeByBusiness.length && <EmptyState title="No income in this period" icon={<TrendingUp className="h-5 w-5" />} />}
              </div>
            </section>

            <section className="rounded-xl border border-ink2/10 bg-paper p-4 shadow-sm">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">Close</div>
                  <h2 className="font-display text-xl font-bold">Monthly close</h2>
                </div>
                <ReceiptText className="h-5 w-5 text-dim" />
              </div>
              <div className="mt-3 grid gap-2 text-sm">
                <CloseRow label="Transactions reviewed" value={String(summary.closeSummary.transactionCount)} />
                <CloseRow label="Missing receipts" value={String(summary.missingReceipts.count)} tone={summary.missingReceipts.count ? 'warning' : 'default'} />
                <CloseRow label="Uncategorized spend" value={fmt$(summary.uncategorized.cents / 100)} tone={summary.uncategorized.count ? 'warning' : 'default'} />
                <CloseRow label="Transfer movement" value={fmt$(summary.transfers.cents / 100)} />
              </div>
            </section>

            <section className="rounded-xl border border-ink2/10 bg-paper p-4 shadow-sm">
              <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">Review queue</div>
              <div className="mt-3 grid gap-2">
                <ReviewRow label="Categorize" value={summary.uncategorized.count} tone={summary.uncategorized.count ? 'warning' : 'positive'} />
                <ReviewRow label="Find receipts" value={summary.missingReceipts.count} tone={summary.missingReceipts.count ? 'warning' : 'positive'} />
                <ReviewRow label="Audit transfers" value={summary.transfers.count} tone="muted" />
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  tone = 'default',
  detail,
}: {
  label: string;
  value: string;
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
      <div className="font-display text-lg font-bold tabular-nums">{value}</div>
      {detail && <div className="mt-1 truncate text-xs font-medium text-dim">{detail}</div>}
    </div>
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

function FilterChip({ active, muted, children, onClick }: { active: boolean; muted?: boolean; children: ReactNode; onClick: () => void }) {
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

function ReviewRow({ label, value, tone }: { label: string; value: number; tone: 'positive' | 'warning' | 'muted' }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-[hsl(var(--color-sunken))] px-3 py-2">
      <span className="text-sm font-bold">{label}</span>
      <Badge variant={tone === 'positive' ? 'success' : tone === 'warning' ? 'warning' : 'muted'}>{value}</Badge>
    </div>
  );
}

function CloseRow({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'warning' }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-[hsl(var(--color-sunken))] px-3 py-2">
      <span className="text-dim">{label}</span>
      <span className={cn('font-bold tabular-nums', tone === 'warning' && 'text-coral-ink')}>{value}</span>
    </div>
  );
}

function incomeWidth(cents: number, rows: Array<{ cents: number }>): number {
  const max = Math.max(...rows.map((row) => row.cents), 1);
  return Math.max(4, (cents / max) * 100);
}

function toggle<T>(value: T, values: T[]): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function exportInsightsCsv(summary: OwnerInsightsSummary) {
  const rows = [
    ['section', 'date', 'merchant', 'business', 'category', 'amount'],
    ...summary.topPurchases.map((purchase) => [
      'top_purchase',
      purchase.date,
      purchase.merchant,
      purchase.biz,
      purchase.cat,
      String(Math.abs(Math.round(purchase.amount * 100))),
    ]),
    ['close_summary', summary.from, 'inflow', '', '', String(summary.closeSummary.inflowCents)],
    ['close_summary', summary.from, 'outflow', '', '', String(summary.closeSummary.outflowCents)],
    ['close_summary', summary.from, 'net', '', '', String(summary.closeSummary.netCents)],
    ['close_summary', summary.from, 'uncategorized', '', '', String(summary.uncategorized.cents)],
    ['close_summary', summary.from, 'missing_receipts', '', '', String(summary.missingReceipts.cents)],
    ['close_summary', summary.from, 'transfers', '', '', String(summary.transfers.cents)],
  ];
  const csv = rows.map((row) => row.map(csvCell).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `ledger-insights-${summary.from}-${summary.to}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
