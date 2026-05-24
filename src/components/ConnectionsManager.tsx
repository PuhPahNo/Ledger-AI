import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Building2, CheckCircle2, CreditCard, Mail, Pencil, PlugZap, RefreshCcw, Trash2 } from 'lucide-react';
import { usePlaidLink } from 'react-plaid-link';
import {
  ApiError,
  backfillConnection as backfillPlaidConnection,
  createPlaidLinkToken,
  disconnectConnection,
  exchangePlaidPublicToken,
  getGmailOAuthUrl,
  syncConnection,
  updateAccountBusiness,
  updateAccountEnabled,
  updateConnectionBusiness,
  updateConnectionLabel,
} from '@/api';
import type { Account, Business, Connection, ConnectionKind, ConnectionStatus } from '@/types/domain';
import { useToast } from '@/hooks/useToast';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState } from '@/components/ui/empty-state';

interface Props {
  open: boolean;
  businesses: Business[];
  connections: Connection[];
  accounts: Account[];
  onClose: () => void;
  onRefresh: () => void;
}

export function ConnectionsManager({ open, businesses, connections, accounts, onClose, onRefresh }: Props) {
  const { toast } = useToast();
  const firstBusiness = businesses[0]?.dbId ?? businesses[0]?.id ?? '';
  const [businessId, setBusinessId] = useState(firstBusiness);
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [pendingPlaidOpen, setPendingPlaidOpen] = useState(false);
  const [busy, setBusy] = useState<'plaid' | 'gmail' | null>(null);
  const activePlaid = useMemo(
    () => connections.filter((c) => c.kind !== 'gmail' && c.status !== 'disconnected').length,
    [connections],
  );
  const activeGmail = useMemo(
    () => connections.filter((c) => c.kind === 'gmail' && c.status !== 'disconnected').length,
    [connections],
  );
  const needsAttention = connections.filter((c) => c.status === 'reauth').length;

  useEffect(() => {
    if (!businessId && firstBusiness) setBusinessId(firstBusiness);
  }, [businessId, firstBusiness]);

  const { open: openPlaid, ready, error: plaidLoadError } = usePlaidLink({
    token: linkToken,
    onSuccess: async (publicToken) => {
      try {
        setBusy('plaid');
        await exchangePlaidPublicToken(publicToken, businessId || undefined);
        toast({ variant: 'success', title: 'Plaid connected', description: 'Initial sync is running in the background.' });
        onRefresh();
      } catch (error) {
        toast({ variant: 'destructive', title: 'Plaid connect failed', description: readableError(error) });
      } finally {
        setBusy(null);
        setLinkToken(null);
      }
    },
    onExit: (error) => {
      if (error) {
        toast({
          variant: 'destructive',
          title: 'Plaid was closed',
          description: error.display_message || error.error_message || 'Plaid was closed before connecting.',
        });
      }
      setPendingPlaidOpen(false);
      setBusy(null);
    },
  });

  useEffect(() => {
    if (pendingPlaidOpen && ready) {
      setPendingPlaidOpen(false);
      openPlaid();
      setBusy(null);
    }
  }, [openPlaid, pendingPlaidOpen, ready]);

  useEffect(() => {
    if (plaidLoadError) {
      setPendingPlaidOpen(false);
      setBusy(null);
      toast({
        variant: 'destructive',
        title: 'Plaid failed to load',
        description: 'Check content blockers and try again.',
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plaidLoadError]);

  useEffect(() => {
    if (!pendingPlaidOpen) return;
    const timeout = window.setTimeout(() => {
      setPendingPlaidOpen(false);
      setBusy(null);
      toast({
        variant: 'destructive',
        title: 'Plaid did not finish loading',
        description: 'Check Plaid credentials and browser content blockers, then try again.',
      });
    }, 15000);
    return () => window.clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPlaidOpen]);

  const startPlaid = async () => {
    if (activePlaid >= 10) {
      toast({ variant: 'destructive', title: 'Plaid limit reached', description: 'Disconnect one before adding another.' });
      return;
    }
    try {
      setBusy('plaid');
      const token = await createPlaidLinkToken();
      setLinkToken(token.link_token);
      setPendingPlaidOpen(true);
    } catch (error) {
      setBusy(null);
      setPendingPlaidOpen(false);
      toast({ variant: 'destructive', title: 'Plaid setup failed', description: readableError(error) });
    }
  };

  const startGmail = async () => {
    try {
      setBusy('gmail');
      const result = await getGmailOAuthUrl(businessId || undefined);
      if (!result.url) throw new Error('Google did not return an OAuth URL.');
      window.location.assign(result.url);
    } catch (error) {
      setBusy(null);
      toast({ variant: 'destructive', title: 'Gmail OAuth failed', description: readableError(error) });
    }
  };

  const refreshConnection = async (connection: Connection) => {
    if (!connection.id) return;
    await syncConnection(connection.id);
    toast({ title: 'Sync queued', description: `Sync queued for ${connection.label}.` });
    onRefresh();
  };

  const backfillConnection = async (connection: Connection) => {
    if (!connection.id) return;
    await backfillPlaidConnection(connection.id, 12);
    toast({
      title: '12-month pull queued',
      description: 'If this connection was created before 12-month history was enabled, reconnect it to expand the window.',
    });
    onRefresh();
  };

  const removeConnection = async (connection: Connection) => {
    if (!connection.id) return;
    await disconnectConnection(connection.id);
    toast({ variant: 'success', title: `Disconnected ${connection.label}` });
    onRefresh();
  };

  const changeConnectionBusiness = async (connection: Connection, next: string) => {
    if (!connection.id) return;
    await updateConnectionBusiness(connection.id, next || null);
    toast({ variant: 'success', title: 'Default business updated' });
    onRefresh();
  };

  const renameConnection = async (connection: Connection, label: string) => {
    if (!connection.id) return;
    await updateConnectionLabel(connection.id, label);
    toast({ variant: 'success', title: `Renamed to ${label}` });
    onRefresh();
  };

  const changeAccountBusiness = async (account: Account, next: string, applyToExisting = false) => {
    await updateAccountBusiness(account.id, next || null, applyToExisting);
    toast({
      variant: 'success',
      title: applyToExisting ? 'Reassigned existing transactions' : 'Default business updated',
      description: applyToExisting
        ? `Existing transactions reassigned for ${account.name}.`
        : `Future transactions for ${account.name} will use the selected business.`,
    });
    onRefresh();
  };

  const changeAccountWatch = async (account: Account, enabled: boolean) => {
    await updateAccountEnabled(account.id, enabled);
    toast({
      variant: 'success',
      title: enabled ? `${account.name} is watched` : `${account.name} is ignored`,
      description: enabled ? 'Included in spend results.' : 'Excluded from spend results.',
    });
    onRefresh();
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent size="xl" className="gap-5">
        <DialogHeader className="flex flex-row items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-ink text-lemon">
            <PlugZap className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle>Connections</DialogTitle>
            <DialogDescription>
              {activePlaid}/10 Plaid · {activeGmail} Gmail · {accounts.length} mapped accounts
            </DialogDescription>
          </div>
          {needsAttention > 0 && (
            <Badge variant="warning" className="mr-12">
              <AlertTriangle className="h-3 w-3" />
              {needsAttention} needs reauth
            </Badge>
          )}
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-3">
          <QuickAction
            icon={<CreditCard className="h-5 w-5" />}
            title="Plaid"
            detail={`${activePlaid}/10 active`}
            disabled={activePlaid >= 10 || Boolean(busy)}
            loading={busy === 'plaid'}
            onClick={startPlaid}
          />
          <QuickAction
            icon={<Mail className="h-5 w-5" />}
            title="Gmail"
            detail={`${activeGmail} inboxes`}
            disabled={Boolean(busy)}
            loading={busy === 'gmail'}
            onClick={startGmail}
          />
          <div className="rounded-lg border border-ink2/10 bg-[hsl(var(--color-sunken))] p-3">
            <Label htmlFor="default-business" className="flex items-center gap-1.5">
              <Building2 className="h-3.5 w-3.5" />
              Default business
            </Label>
            <div className="mt-2">
              <BusinessSelect id="default-business" value={businessId} businesses={businesses} onChange={setBusinessId} includeAll={false} />
            </div>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-baseline gap-2">
                Providers
                <span className="text-xs font-normal text-dim">{connections.length}</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2">
              {connections.length ? (
                connections.map((connection) => (
                  <ProviderRow
                    key={connection.id ?? connection.label}
                    connection={connection}
                    businesses={businesses}
                    onBusiness={(next) => changeConnectionBusiness(connection, next)}
                    onRename={(label) => renameConnection(connection, label)}
                    onSync={() => refreshConnection(connection)}
                    onBackfill={connection.kind === 'gmail' ? undefined : () => backfillConnection(connection)}
                    onDisconnect={() => removeConnection(connection)}
                  />
                ))
              ) : (
                <EmptyState title="No providers" description="Add a Plaid or Gmail connection to start syncing." />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-baseline gap-2">
                Accounts and cards
                <span className="text-xs font-normal text-dim">{accounts.length}</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2">
              {accounts.length ? (
                accounts.map((account) => (
                  <AccountRow
                    key={account.id}
                    account={account}
                    businesses={businesses}
                    onBusiness={(next, applyToExisting = false) => changeAccountBusiness(account, next, applyToExisting)}
                    onEnabled={(enabled) => changeAccountWatch(account, enabled)}
                  />
                ))
              ) : (
                <EmptyState title="No accounts yet" description="Plaid accounts appear after the first sync." />
              )}
            </CardContent>
          </Card>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function readableError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong. Try again.';
}

function QuickAction({
  icon,
  title,
  detail,
  disabled = false,
  loading = false,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  disabled?: boolean;
  loading?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex items-center gap-3 rounded-lg border border-ink2/10 bg-[hsl(var(--color-sunken))] p-3 text-left transition-all hover:border-ink2/25 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-md bg-ink text-lemon">{icon}</span>
      <span className="grid">
        <span className="font-bold text-ink">{title}</span>
        <span className="text-xs text-dim">{loading ? 'Working…' : detail}</span>
      </span>
    </button>
  );
}

function ProviderRow({
  connection,
  businesses,
  onBusiness,
  onRename,
  onSync,
  onBackfill,
  onDisconnect,
}: {
  connection: Connection;
  businesses: Business[];
  onBusiness: (businessId: string) => void;
  onRename: (label: string) => void;
  onSync: () => void;
  onBackfill?: () => void;
  onDisconnect: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(connection.label);
  useEffect(() => setLabel(connection.label), [connection.label]);

  const saveLabel = () => {
    const next = label.trim();
    if (!next || next === connection.label) {
      setEditing(false);
      setLabel(connection.label);
      return;
    }
    onRename(next);
    setEditing(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-ink2/8 bg-[hsl(var(--color-sunken))] p-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-paper text-ink">
        {connection.kind === 'gmail' ? <Mail className="h-4 w-4" /> : <CreditCard className="h-4 w-4" />}
      </span>
      <div className="min-w-0 flex-1">
        {editing ? (
          <Input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            onBlur={saveLabel}
            onKeyDown={(event) => {
              if (event.key === 'Enter') saveLabel();
              if (event.key === 'Escape') {
                setLabel(connection.label);
                setEditing(false);
              }
            }}
            autoFocus
            className="h-7"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="flex w-full items-center gap-1.5 truncate text-left font-bold text-ink hover:text-ink/80"
          >
            <span className="truncate">{connection.label}</span>
            <Pencil className="h-3 w-3 shrink-0 text-dim" />
          </button>
        )}
        <div className="truncate text-xs text-dim">{connection.last}</div>
      </div>
      <StatusBadge status={connection.status} />
      <div className="w-44">
        <BusinessSelect value={connection.businessId ?? ''} businesses={businesses} onChange={onBusiness} />
      </div>
      <div className="flex gap-1">
        {onBackfill && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" onClick={onBackfill} className="px-2 text-xs">
                12m
              </Button>
            </TooltipTrigger>
            <TooltipContent>Pull 12 months of Plaid history</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="icon-sm" onClick={onSync}>
              <RefreshCcw className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Sync now</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="icon-sm" onClick={onDisconnect} className="text-coral-ink hover:bg-coral/10">
              <Trash2 className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Disconnect</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

function AccountRow({
  account,
  businesses,
  onBusiness,
  onEnabled,
}: {
  account: Account;
  businesses: Business[];
  onBusiness: (businessId: string, applyToExisting?: boolean) => void;
  onEnabled: (enabled: boolean) => void;
}) {
  return (
    <div className={`flex flex-wrap items-center gap-3 rounded-lg border border-ink2/8 bg-[hsl(var(--color-sunken))] p-3 ${account.enabled ? '' : 'opacity-60'}`}>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-paper text-ink">
        {account.kind === 'credit' ? <CreditCard className="h-4 w-4" /> : <Mail className="h-4 w-4" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-bold text-ink">{account.name}</div>
        <div className="truncate text-xs text-dim">
          {account.kind}
          {account.mask ? ` · ${account.mask}` : ''} · {account.enabled ? 'included in spend' : 'ignored'}
        </div>
      </div>
      <div className="w-44">
        <BusinessSelect value={account.businessId ?? ''} businesses={businesses} onChange={(next) => onBusiness(next, true)} />
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            disabled={!account.businessId}
            onClick={() => onBusiness(account.businessId ?? '', true)}
          >
            Reassign existing
          </Button>
        </TooltipTrigger>
        <TooltipContent>Apply current business to past transactions</TooltipContent>
      </Tooltip>
      <div className="flex items-center gap-2 text-xs font-bold text-dim">
        <Switch checked={account.enabled} onCheckedChange={onEnabled} />
        {account.enabled ? 'Watched' : 'Ignored'}
      </div>
    </div>
  );
}

function BusinessSelect({
  id,
  value,
  businesses,
  onChange,
  includeAll = true,
}: {
  id?: string;
  value: string;
  businesses: Business[];
  onChange: (value: string) => void;
  includeAll?: boolean;
}) {
  return (
    <Select value={value || (includeAll ? '__unassigned__' : '')} onValueChange={(next) => onChange(next === '__unassigned__' ? '' : next)}>
      <SelectTrigger id={id} className="h-9">
        <SelectValue placeholder={includeAll ? 'Unassigned' : 'Choose'} />
      </SelectTrigger>
      <SelectContent>
        {includeAll && <SelectItem value="__unassigned__">Unassigned</SelectItem>}
        {businesses.map((business) => (
          <SelectItem key={business.dbId ?? business.id} value={business.dbId ?? business.id}>
            {business.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function StatusBadge({ status }: { status: ConnectionStatus }) {
  if (status === 'live') {
    return (
      <Badge variant="success">
        <CheckCircle2 className="h-3 w-3" />
        Live
      </Badge>
    );
  }
  if (status === 'reauth') {
    return (
      <Badge variant="warning">
        <AlertTriangle className="h-3 w-3" />
        Needs reauth
      </Badge>
    );
  }
  return <Badge variant="muted">Disconnected</Badge>;
}

// Helper exports kept for potential reuse — currently only ConnectionKind / kind icons depend on this file.
export type { ConnectionKind };
