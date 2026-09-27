import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { disconnectQuickbooks, getQuickbooksMappings, startQuickbooksConnect, syncQuickbooks } from '@/api/quickbooks';
import type { Business } from '@/types/domain';
import type { QboBusinessStatus, QboMappings } from '@/types/quickbooks';
import { useToast } from '@/hooks/useToast';
import { timeAgo } from '@/lib/reviewGroups';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { QuickbooksMappings } from './QuickbooksMappings';
import { useQuickbooksStatus } from './useQuickbooksStatus';

const ENV_VARS = ['QUICKBOOKS_CLIENT_ID', 'QUICKBOOKS_CLIENT_SECRET', 'QUICKBOOKS_REDIRECT_URI'];

/**
 * Settings › Businesses & accounts › QuickBooks: one row per business — connect, sync,
 * reconnect, disconnect — plus the account/category mapping editor (collapsed).
 */
export function QuickbooksSettings({ businesses }: { businesses: Business[] }) {
  const { status, error, reload } = useQuickbooksStatus();
  const colorByKey = new Map(businesses.map((business) => [business.id, business.color]));
  const activeKeys = new Set(businesses.filter((business) => business.active !== false).map((business) => business.id));

  return (
    <Card>
      <CardHeader>
        <CardTitle>QuickBooks</CardTitle>
        <CardDescription>Read-only: contractors, payees and receipts from your books. Nothing is written back.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        {error && !status ? (
          <div role="alert" className="rounded-lg border border-coral/30 bg-coral/10 p-3 text-sm font-bold text-coral-ink">Couldn't load QuickBooks: {error}</div>
        ) : !status ? (
          <div className="grid gap-2" aria-hidden="true">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        ) : !status.configured ? (
          <div className="rounded-lg bg-[hsl(var(--color-sunken))] p-3 text-sm text-dim">
            <div className="font-bold text-ink">Not set up on this server</div>
            <p className="mt-1">
              To connect QuickBooks, set{' '}
              {ENV_VARS.map((name, index) => (
                <span key={name}>
                  <code className="rounded bg-paper px-1 py-px font-mono text-[11px] text-ink">{name}</code>
                  {index < ENV_VARS.length - 2 ? ', ' : index === ENV_VARS.length - 2 ? ' and ' : ''}
                </span>
              ))}{' '}
              on the backend (plus <code className="rounded bg-paper px-1 py-px font-mono text-[11px] text-ink">QUICKBOOKS_ENV=production</code> for live books), then restart it.
            </p>
          </div>
        ) : (
          <ul className="grid gap-2">
            {status.businesses
              .filter((business) => business.connection || !activeKeys.size || activeKeys.has(business.businessKey))
              .map((business) => (
                <BusinessRow
                  key={business.businessId}
                  business={business}
                  color={colorByKey.get(business.businessKey)}
                  sandbox={status.environment === 'sandbox'}
                  onChanged={reload}
                />
              ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function BusinessRow({
  business,
  color,
  sandbox,
  onChanged,
}: {
  business: QboBusinessStatus;
  color?: string;
  sandbox: boolean;
  onChanged: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<'connect' | 'sync' | 'disconnect' | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [mappings, setMappings] = useState<QboMappings | null>(null);
  const connection = business.connection;

  useEffect(() => {
    if (!connection) {
      setMappings(null);
      return;
    }
    let cancelled = false;
    getQuickbooksMappings(connection.id).then((result) => !cancelled && setMappings(result)).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [connection?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const connect = async () => {
    setBusy('connect');
    try {
      const { url } = await startQuickbooksConnect(business.businessId);
      window.location.assign(url);
    } catch (error) {
      toast({ variant: 'destructive', title: 'Could not start QuickBooks sign-in', description: error instanceof Error ? error.message : 'Try again.' });
      setBusy(null);
    }
  };

  const sync = async () => {
    if (!connection) return;
    setBusy('sync');
    try {
      const result = await syncQuickbooks(connection.id);
      toast({ variant: 'success', title: result.alreadyQueued ? 'A sync is already running' : 'Sync started', description: 'New QuickBooks records appear in a minute or two.' });
      await onChanged();
    } catch (error) {
      toast({ variant: 'destructive', title: 'Sync failed to start', description: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    if (!connection) return;
    setBusy('disconnect');
    try {
      await disconnectQuickbooks(connection.id);
      setConfirmOpen(false);
      toast({ title: `QuickBooks disconnected from ${business.businessName}`, description: 'Synced history is kept.' });
      await onChanged();
    } catch (error) {
      toast({ variant: 'destructive', title: 'Disconnect failed', description: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setBusy(null);
    }
  };

  const reauth = connection?.status === 'reauth';
  const live = connection?.status === 'live';

  return (
    <li className="grid gap-2 rounded-lg border border-ink2/10 p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-56">
          <div className="flex flex-wrap items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color ?? 'hsl(var(--color-dim))' }} aria-hidden="true" />
            <span className="text-sm font-bold text-ink">{business.businessName}</span>
            {reauth && <Badge variant="warning">Reconnect needed</Badge>}
            {connection?.syncing && (
              <Badge variant="muted">
                <Loader2 className="h-3 w-3 animate-spin" />
                Syncing
              </Badge>
            )}
            {connection && sandbox && <Badge variant="outline">Sandbox</Badge>}
          </div>
          <div className="mt-0.5 text-xs text-dim">
            {!connection
              ? 'Not connected'
              : [
                connection.companyName ?? 'QuickBooks company',
                connection.lastSyncAt ? `synced ${timeAgo(connection.lastSyncAt)}` : 'first sync pending',
                `${connection.counts.transactions.toLocaleString('en-US')} records · ${connection.counts.linked.toLocaleString('en-US')} linked`,
                connection.counts.attachments ? `${connection.counts.attachments} attachments` : null,
              ].filter(Boolean).join(' · ')}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {!connection && (
            <Button size="sm" onClick={() => void connect()} disabled={busy === 'connect'}>
              {busy === 'connect' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Connect
            </Button>
          )}
          {reauth && (
            <Button size="sm" onClick={() => void connect()} disabled={busy === 'connect'}>
              Reconnect
            </Button>
          )}
          {live && (
            <Button variant="outline" size="sm" onClick={() => void sync()} disabled={busy === 'sync' || connection?.syncing}>
              <RefreshCw className={busy === 'sync' ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
              Sync now
            </Button>
          )}
          {connection && (
            <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(true)}>
              Disconnect
            </Button>
          )}
        </div>
      </div>

      {connection?.lastSyncError && (
        <div className="flex items-start gap-2 rounded-md bg-coral/10 px-2.5 py-1.5 text-xs text-coral-ink">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>{connection.lastSyncError}</span>
        </div>
      )}

      {connection && (mappings
        ? <QuickbooksMappings mappings={mappings} onChange={setMappings} />
        : <Skeleton className="h-10" />)}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect QuickBooks from {business.businessName}?</DialogTitle>
            <DialogDescription>
              Syncing stops and Ledger's access is revoked. Synced records, links and mappings are kept — reconnecting the same company picks up where it left off.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => void disconnect()} disabled={busy === 'disconnect'}>
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}
