import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Building2, CreditCard, Mail, PlugZap } from 'lucide-react';
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
  updateAccountNickname,
  updateConnectionBusiness,
  updateConnectionLabel,
} from '@/api';
import type { Account, Business, Connection } from '@/types/domain';
import { useToast } from '@/hooks/useToast';
import { accountLabel } from '@/lib/account';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { EmptyState } from '@/components/ui/empty-state';
import { AccountRow } from './connections/AccountRow';
import { BusinessSelect } from './connections/BusinessSelect';
import { ProviderRow } from './connections/ProviderRow';
import { QuickAction } from './connections/QuickAction';

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
        ? `Existing transactions reassigned for ${accountLabel(account)}.`
        : `Future transactions for ${accountLabel(account)} will use the selected business.`,
    });
    onRefresh();
  };

  const renameAccount = async (account: Account, nickname: string | null) => {
    await updateAccountNickname(account.id, nickname);
    toast({
      variant: 'success',
      title: nickname ? `Renamed to "${nickname}"` : 'Account name reset',
    });
    onRefresh();
  };

  const changeAccountWatch = async (account: Account, enabled: boolean) => {
    await updateAccountEnabled(account.id, enabled);
    toast({
      variant: 'success',
      title: enabled ? `${accountLabel(account)} is watched` : `${accountLabel(account)} is ignored`,
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
                    onRename={(nickname) => renameAccount(account, nickname)}
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
