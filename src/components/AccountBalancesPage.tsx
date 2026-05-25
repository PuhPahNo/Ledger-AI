import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { CreditCard, Landmark, RefreshCw, Wifi } from 'lucide-react';
import { listAccounts, listBusinesses, uploadReceipt } from '@/api';
import type { Account, Business, CurrentUser } from '@/types/domain';
import type { AppView } from '@/types/navigation';
import { accountLabel } from '@/lib/account';
import { summarizeAccountBalances } from '@/lib/calc';
import { fmt$ } from '@/lib/format';
import { useToast } from '@/hooks/useToast';
import { HeaderBar } from './HeaderBar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/cn';

interface Props {
  user?: CurrentUser;
  onViewChange?: (view: AppView) => void;
  onLogout?: () => void;
}

type WatchFilter = 'all' | 'watched' | 'ignored';

export function AccountBalancesPage({ user, onViewChange, onLogout }: Props) {
  const { toast } = useToast();
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [business, setBusiness] = useState('all');
  const [watchFilter, setWatchFilter] = useState<WatchFilter>('all');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    Promise.all([listBusinesses(), listAccounts({ biz: business })])
      .then(([businessRows, accountRows]) => {
        setBusinesses(businessRows);
        setAccounts(accountRows);
      })
      .catch((loadError: Error) => setError(loadError.message));
  }, [business, refreshKey]);

  const filteredAccounts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return accounts
      .filter((account) => watchFilter === 'all' || (watchFilter === 'watched' ? account.enabled : !account.enabled))
      .filter((account) => !needle || [
        account.name,
        account.nickname,
        account.officialName,
        account.mask,
        account.connectionLabel,
        account.kind,
      ].filter(Boolean).join(' ').toLowerCase().includes(needle));
  }, [accounts, query, watchFilter]);
  const summary = summarizeAccountBalances(filteredAccounts);
  const businessById = useMemo(() => new Map(businesses.map((item) => [item.id, item])), [businesses]);
  const selectedBusinessName = business === 'all' ? 'All businesses' : businesses.find((item) => item.id === business)?.name ?? business;
  const bankAccounts = filteredAccounts.filter((account) => account.kind !== 'credit');
  const creditAccounts = filteredAccounts.filter((account) => account.kind === 'credit');
  const connectionCounts = countConnectionStatuses(filteredAccounts);

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
      <div className="mx-auto flex max-w-[1400px] flex-col gap-4 p-4">
        <HeaderBar
          onUploadReceipt={handleUpload}
          currentView="balances"
          onViewChange={onViewChange}
          onLogout={onLogout}
          user={user}
          query={query}
          onQueryChange={setQuery}
        />

        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">Plaid balances</div>
            <h1 className="font-display text-3xl font-bold tracking-tight">Account Balances</h1>
            <div className="mt-1 text-sm text-dim">{selectedBusinessName} · Current Plaid snapshot</div>
          </div>
          <Button variant="outline" onClick={() => setRefreshKey((key) => key + 1)} className="w-full sm:w-auto">
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        </div>

        <div className="grid gap-3 md:grid-cols-5">
          <Metric label="Bank cash" value={fmt$(summary.bankBalanceCents / 100)} detail={`${bankAccounts.length} bank accounts`} tone="positive" />
          <Metric label="Bank available" value={fmt$(summary.bankAvailableCents / 100)} detail="Spendable balance" tone="muted" />
          <Metric label="Credit balance" value={fmt$(summary.creditBalanceCents / 100)} detail={`${creditAccounts.length} card accounts`} tone="warning" />
          <Metric label="Net cash" value={fmt$(summary.netCashCents / 100)} detail="Banks minus cards" tone={summary.netCashCents >= 0 ? 'positive' : 'warning'} />
          <Metric label="Watched / ignored" value={`${summary.watched} / ${summary.ignored}`} detail={`${filteredAccounts.length} shown`} tone="muted" />
        </div>

        <div className="grid gap-3 rounded-xl border border-ink2/10 bg-paper p-3 shadow-sm md:grid-cols-[220px_220px_1fr]">
          <Field label="Business">
            <Select value={business} onValueChange={setBusiness}>
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
            <Select value={watchFilter} onValueChange={(value) => setWatchFilter(value as WatchFilter)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All accounts</SelectItem>
                <SelectItem value="watched">Watched only</SelectItem>
                <SelectItem value="ignored">Ignored only</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <div className="flex flex-wrap items-end gap-2">
            <Badge variant="secondary">Snapshot only</Badge>
            <Badge variant={connectionCounts.reauth ? 'warning' : 'success'}>{connectionCounts.live} live</Badge>
            {connectionCounts.reauth > 0 && <Badge variant="warning">{connectionCounts.reauth} reauth</Badge>}
          </div>
        </div>

        {error && <div className="rounded-xl border border-coral/30 bg-coral/10 p-4 text-sm font-bold text-coral-ink">{error}</div>}

        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_340px]">
          <section className="overflow-hidden rounded-xl border border-ink2/10 bg-paper shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink2/10 px-4 py-3">
              <div>
                <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">Accounts</div>
                <h2 className="font-display text-xl font-bold">Current balances</h2>
              </div>
              <Badge variant="muted">{filteredAccounts.length} accounts</Badge>
            </div>
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead className="w-44">Business</TableHead>
                  <TableHead className="w-28">Kind</TableHead>
                  <TableHead className="w-28">State</TableHead>
                  <TableHead className="w-40 text-right">Current</TableHead>
                  <TableHead className="w-40 text-right">Available</TableHead>
                  <TableHead className="w-52">Connection</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredAccounts.map((account) => {
                  const businessRow = businessById.get(String(account.biz));
                  return (
                    <TableRow key={account.id}>
                      <TableCell>
                        <div className="flex min-w-0 items-center gap-3">
                          <AccountGlyph kind={account.kind} />
                          <div className="min-w-0">
                            <div className="truncate font-bold" title={accountLabel(account)}>{accountLabel(account)}</div>
                            {account.officialName && <div className="truncate text-xs text-dim">{account.officialName}</div>}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="truncate">{businessRow?.name ?? (account.biz === 'all' ? 'Unassigned' : account.biz)}</TableCell>
                      <TableCell className="capitalize">{account.kind}</TableCell>
                      <TableCell>
                        <Badge variant={account.enabled ? 'success' : 'muted'}>{account.enabled ? 'watched' : 'ignored'}</Badge>
                      </TableCell>
                      <TableCell className={cn('text-right font-display font-bold tabular-nums', account.kind === 'credit' && 'text-coral-ink')}>
                        {formatCents(account.currentBalanceCents)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-dim">{formatCents(account.availableBalanceCents)}</TableCell>
                      <TableCell>
                        <div className="truncate text-xs font-bold">{account.connectionLabel ?? '-'}</div>
                        <Badge variant={account.connectionStatus === 'live' ? 'success' : account.connectionStatus === 'reauth' ? 'warning' : 'muted'}>
                          {account.connectionStatus ?? 'unknown'}
                        </Badge>
                        <div className="mt-1 truncate text-xs text-dim">{formatSyncTime(account.connectionLastSyncAt)}</div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {!filteredAccounts.length && (
              <div className="p-4">
                <EmptyState title="No accounts match these filters" icon={<Landmark className="h-5 w-5" />} />
              </div>
            )}
          </section>

          <aside className="grid gap-3">
            <section className="rounded-xl border border-ink2/10 bg-paper p-4 shadow-sm">
              <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">Account mix</div>
              <div className="mt-3 grid gap-2">
                <SideStat icon={<Landmark className="h-4 w-4" />} label="Bank accounts" value={String(bankAccounts.length)} />
                <SideStat icon={<CreditCard className="h-4 w-4" />} label="Credit cards" value={String(creditAccounts.length)} tone="warning" />
                <SideStat label="Other" value={String(filteredAccounts.length - bankAccounts.length - creditAccounts.length)} tone="muted" />
              </div>
            </section>

            <section className="rounded-xl border border-ink2/10 bg-paper p-4 shadow-sm">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">Connections</div>
                  <h2 className="font-display text-xl font-bold">Health</h2>
                </div>
                <Wifi className="h-5 w-5 text-dim" />
              </div>
              <div className="grid gap-2">
                <ConnectionRow label="Live" value={connectionCounts.live} variant="success" />
                <ConnectionRow label="Needs reauth" value={connectionCounts.reauth} variant={connectionCounts.reauth ? 'warning' : 'muted'} />
                <ConnectionRow label="Disconnected" value={connectionCounts.disconnected} variant={connectionCounts.disconnected ? 'danger' : 'muted'} />
                <ConnectionRow label="Unknown" value={connectionCounts.unknown} variant="muted" />
              </div>
            </section>
          </aside>
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

function AccountGlyph({ kind }: { kind: Account['kind'] }) {
  const Icon = kind === 'credit' ? CreditCard : Landmark;
  return (
    <div className={cn(
      'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
      kind === 'credit' ? 'bg-coral/15 text-coral-ink' : 'bg-sage/15 text-sage-ink',
    )}>
      <Icon className="h-4 w-4" />
    </div>
  );
}

function SideStat({
  icon,
  label,
  value,
  tone = 'default',
}: {
  icon?: ReactNode;
  label: string;
  value: string;
  tone?: 'default' | 'warning' | 'muted';
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-[hsl(var(--color-sunken))] px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        {icon && <span className="text-dim">{icon}</span>}
        <span className="truncate text-sm font-bold">{label}</span>
      </div>
      <span className={cn('font-display font-bold tabular-nums', tone === 'warning' && 'text-coral-ink', tone === 'muted' && 'text-dim')}>{value}</span>
    </div>
  );
}

function ConnectionRow({
  label,
  value,
  variant,
}: {
  label: string;
  value: number;
  variant: 'success' | 'warning' | 'danger' | 'muted';
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-[hsl(var(--color-sunken))] px-3 py-2">
      <span className="text-sm font-bold">{label}</span>
      <Badge variant={variant}>{value}</Badge>
    </div>
  );
}

function countConnectionStatuses(accounts: Account[]) {
  return accounts.reduce(
    (counts, account) => {
      if (account.connectionStatus === 'live') counts.live += 1;
      else if (account.connectionStatus === 'reauth') counts.reauth += 1;
      else if (account.connectionStatus === 'disconnected') counts.disconnected += 1;
      else counts.unknown += 1;
      return counts;
    },
    { live: 0, reauth: 0, disconnected: 0, unknown: 0 },
  );
}

function formatCents(value?: number | null): string {
  return value == null ? '-' : fmt$(value / 100);
}

function formatSyncTime(value?: string | null): string {
  if (!value) return 'Never synced';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}
