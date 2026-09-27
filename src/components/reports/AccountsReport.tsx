import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, CreditCard, Landmark, Mail, RefreshCw } from 'lucide-react';
import { listAccounts, listConnections } from '@/api';
import type { Account, Connection } from '@/types/domain';
import { accountLabel } from '@/lib/account';
import { fmt$ } from '@/lib/format';
import { cn } from '@/lib/cn';
import { isTroubledConnection } from '@/hooks/useInbox';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ReportCard } from './ReportCard';
import type { ReportTabProps } from './reportTabs';

type WatchFilter = 'watched' | 'all' | 'ignored';

/**
 * Reports › Accounts: every account's current balance (grouped, with subtotals) and the
 * health of the connections feeding them. Home only shows the cash-on-hand total.
 */
export function AccountsReport({ business, businesses, onViewChange }: ReportTabProps) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [watch, setWatch] = useState<WatchFilter>('watched');
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError('');
    Promise.all([listAccounts({ biz: business }), listConnections({ biz: business })])
      .then(([accountRows, connectionRows]) => {
        if (cancelled) return;
        setAccounts(accountRows);
        setConnections(connectionRows);
      })
      .catch((loadError: Error) => !cancelled && setError(loadError.message));
    return () => {
      cancelled = true;
    };
  }, [business, refreshKey]);

  const businessById = useMemo(() => new Map(businesses.map((item) => [item.id, item])), [businesses]);
  const visible = (accounts ?? []).filter((account) => watch === 'all' || (watch === 'watched' ? account.enabled : !account.enabled));
  const groups = [
    { id: 'bank', label: 'Bank & cash', rows: visible.filter((account) => account.kind !== 'credit') },
    { id: 'credit', label: 'Credit cards', rows: visible.filter((account) => account.kind === 'credit') },
  ].filter((group) => group.rows.length > 0);
  const openConnections = () => onViewChange?.({ view: 'settings', section: 'businesses' });

  return (
    <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_340px]">
      <ReportCard
        eyebrow="Balances"
        title="Accounts"
        error={error || undefined}
        action={(
          <div className="flex flex-wrap items-center gap-2">
            <ToggleGroup type="single" size="sm" value={watch} aria-label="Accounts shown" onValueChange={(value) => value && setWatch(value as WatchFilter)}>
              <ToggleGroupItem value="watched">Watched</ToggleGroupItem>
              <ToggleGroupItem value="ignored">Ignored</ToggleGroupItem>
              <ToggleGroupItem value="all">All</ToggleGroupItem>
            </ToggleGroup>
            <Button variant="outline" size="icon-sm" onClick={() => setRefreshKey((key) => key + 1)} title="Refresh" aria-label="Refresh balances">
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      >
        {!accounts ? (
          <Skeleton className="h-48" />
        ) : groups.length === 0 ? (
          <EmptyState icon={<Landmark className="h-5 w-5" />} title="No accounts match" description="Link a bank or card under Settings › Businesses & accounts." />
        ) : (
          <div className="grid gap-4">
            {groups.map((group) => {
              const current = group.rows.reduce((sum, account) => sum + (account.currentBalanceCents ?? 0), 0);
              const available = group.rows.reduce((sum, account) => sum + (account.availableBalanceCents ?? 0), 0);
              return (
                <section key={group.id} aria-label={group.label}>
                  <div className="flex items-baseline justify-between gap-3 border-b border-ink2/10 pb-1.5">
                    <h3 className="font-mono text-[10px] font-medium uppercase tracking-wider text-dim">{group.label}</h3>
                    <span className="text-xs text-dim">
                      {group.id === 'credit' ? 'Owed ' : ''}
                      <b className={cn('font-display text-sm tabular-nums', group.id === 'credit' ? 'text-coral-ink' : 'text-ink')}>{fmt$(current / 100)}</b>
                      <span className="hidden sm:inline"> · {fmt$(available / 100)} available</span>
                    </span>
                  </div>
                  <ul className="divide-y divide-ink2/5">
                    {group.rows.map((account) => (
                      <AccountLine key={account.id} account={account} businessName={businessById.get(String(account.biz))?.name} />
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </ReportCard>

      <ReportCard eyebrow="Connections" title="Health">
        {connections.length === 0 ? (
          <div className="py-4 text-sm text-dim">No connections yet.</div>
        ) : (
          <ul className="grid gap-1.5">
            {connections.map((connection) => (
              <ConnectionLine key={connection.id ?? connection.label} connection={connection} onFix={openConnections} />
            ))}
          </ul>
        )}
        <Button variant="ghost" size="sm" className="mt-2" onClick={openConnections}>
          Manage connections
          <ArrowRight className="h-3.5 w-3.5" />
        </Button>
      </ReportCard>
    </div>
  );
}

function AccountLine({ account, businessName }: { account: Account; businessName?: string }) {
  const Icon = account.kind === 'credit' ? CreditCard : Landmark;
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 py-2.5">
      <span
        className={cn(
          'row-span-2 flex h-9 w-9 items-center justify-center rounded-lg sm:row-span-1',
          account.kind === 'credit' ? 'bg-coral/15 text-coral-ink' : 'bg-sage/15 text-sage-ink',
        )}
        aria-hidden="true"
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-bold text-ink" title={accountLabel(account)}>{accountLabel(account)}</span>
          {!account.enabled && <Badge variant="muted">ignored</Badge>}
        </span>
        <span className="block truncate text-xs text-dim">
          {[businessName ?? (account.biz === 'all' ? 'Unassigned' : account.biz), account.mask, account.connectionLabel].filter(Boolean).join(' · ')}
        </span>
      </span>
      <span className="text-right">
        <span className={cn('block font-display text-sm font-bold tabular-nums', account.kind === 'credit' ? 'text-coral-ink' : 'text-ink')}>
          {account.currentBalanceCents == null ? '—' : fmt$(account.currentBalanceCents / 100)}
        </span>
        <span className="block text-[11px] tabular-nums text-dim">
          {account.availableBalanceCents == null ? '' : `${fmt$(account.availableBalanceCents / 100)} avail.`}
        </span>
      </span>
    </li>
  );
}

function ConnectionLine({ connection, onFix }: { connection: Connection; onFix: () => void }) {
  const troubled = isTroubledConnection(connection);
  const Icon = connection.kind === 'gmail' ? Mail : connection.kind === 'card' ? CreditCard : Landmark;
  const lastSync = connection.health?.lastSyncAt ?? connection.lastSyncAt;
  const problem = connection.status !== 'live'
    ? `Needs ${connection.status === 'reauth' ? 'reconnecting' : 'attention'}`
    : connection.health?.lastJobError ?? (connection.health?.failedJobCount ? `${connection.health.failedJobCount} failed sync${connection.health.failedJobCount === 1 ? '' : 's'}` : null);
  return (
    <li className={cn('flex items-center gap-3 rounded-lg px-3 py-2', troubled ? 'bg-coral/10' : 'bg-[hsl(var(--color-sunken))]')}>
      <Icon className={cn('h-4 w-4 shrink-0', troubled ? 'text-coral-ink' : 'text-dim')} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-bold text-ink">{connection.label}</span>
        <span className={cn('block truncate text-xs', troubled ? 'text-coral-ink' : 'text-dim')}>
          {problem ?? `Synced ${formatSync(lastSync) ?? connection.last}`}
        </span>
      </span>
      {troubled ? (
        <Button variant="outline" size="sm" onClick={onFix}>Fix</Button>
      ) : (
        <Badge variant="success">live</Badge>
      )}
    </li>
  );
}

function formatSync(value?: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

