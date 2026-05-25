import { useEffect, useMemo, useState } from 'react';
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
          </div>
          <Button variant="outline" onClick={() => setRefreshKey((key) => key + 1)}>Refresh</Button>
        </div>

        <div className="grid gap-3 md:grid-cols-5">
          <Metric label="Bank Cash" value={fmt$(summary.bankBalanceCents / 100)} tone="positive" />
          <Metric label="Bank Available" value={fmt$(summary.bankAvailableCents / 100)} tone="muted" />
          <Metric label="Credit Balance" value={fmt$(summary.creditBalanceCents / 100)} tone="warning" />
          <Metric label="Net Cash" value={fmt$(summary.netCashCents / 100)} tone={summary.netCashCents >= 0 ? 'positive' : 'warning'} />
          <Metric label="Watched / Ignored" value={`${summary.watched} / ${summary.ignored}`} tone="muted" />
        </div>

        <div className="grid gap-3 rounded-xl border border-ink2/10 bg-paper p-3 shadow-sm md:grid-cols-[220px_220px_1fr]">
          <div className="grid gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-wider text-dim">Business</span>
            <Select value={business} onValueChange={setBusiness}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All businesses</SelectItem>
                {businesses.map((item) => (
                  <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-wider text-dim">Accounts</span>
            <Select value={watchFilter} onValueChange={(value) => setWatchFilter(value as WatchFilter)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All accounts</SelectItem>
                <SelectItem value="watched">Watched only</SelectItem>
                <SelectItem value="ignored">Ignored only</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end text-sm text-dim">
            Current balances come directly from the latest Plaid account payload; no historical trend is implied.
          </div>
        </div>

        {error && <div className="rounded-xl border border-coral/30 bg-coral/10 p-4 text-sm font-bold text-coral-ink">{error}</div>}

        <div className="overflow-hidden rounded-xl border border-ink2/10 bg-paper shadow-sm">
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
                      <div className="truncate font-bold" title={accountLabel(account)}>{accountLabel(account)}</div>
                      {account.officialName && <div className="truncate text-xs text-dim">{account.officialName}</div>}
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
            <div className="p-8 text-center text-sm text-dim">No accounts match the current filters.</div>
          )}
        </div>
      </div>
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
