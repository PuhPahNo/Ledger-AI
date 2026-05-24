import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Building2, CheckCircle2, CreditCard, Mail, PlugZap, RefreshCcw, Trash2, X } from 'lucide-react';
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
} from '@/api';
import type { Account, Business, Connection, ConnectionKind, ConnectionStatus } from '@/types/domain';
import { colors, fonts, radii } from '@/theme/tokens';

interface Props {
  open: boolean;
  businesses: Business[];
  connections: Connection[];
  accounts: Account[];
  onClose: () => void;
  onRefresh: () => void;
}

export function ConnectionsManager({ open, businesses, connections, accounts, onClose, onRefresh }: Props) {
  const firstBusiness = businesses[0]?.dbId ?? businesses[0]?.id ?? '';
  const [businessId, setBusinessId] = useState(firstBusiness);
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [pendingPlaidOpen, setPendingPlaidOpen] = useState(false);
  const [busy, setBusy] = useState<'plaid' | 'gmail' | null>(null);
  const [status, setStatus] = useState('');
  const activePlaid = useMemo(() => connections.filter((c) => c.kind !== 'gmail' && c.status !== 'disconnected').length, [connections]);
  const activeGmail = useMemo(() => connections.filter((c) => c.kind === 'gmail' && c.status !== 'disconnected').length, [connections]);
  const needsAttention = connections.filter((c) => c.status === 'reauth').length;

  useEffect(() => {
    if (!businessId && firstBusiness) setBusinessId(firstBusiness);
  }, [businessId, firstBusiness]);

  const { open: openPlaid, ready, error: plaidLoadError } = usePlaidLink({
    token: linkToken,
    onSuccess: async (publicToken) => {
      try {
        setBusy('plaid');
        setStatus('Connecting Plaid...');
        await exchangePlaidPublicToken(publicToken, businessId || undefined);
        setStatus('Plaid connected. Initial sync is running in the background.');
        onRefresh();
      } catch (error) {
        setStatus(readableError(error));
      } finally {
        setBusy(null);
        setLinkToken(null);
      }
    },
    onExit: (error) => {
      if (error) setStatus(error.display_message || error.error_message || 'Plaid was closed before connecting.');
      else if (pendingPlaidOpen || busy === 'plaid') setStatus('Plaid was closed before connecting.');
      setPendingPlaidOpen(false);
      setBusy(null);
    },
  });

  useEffect(() => {
    if (pendingPlaidOpen && ready) {
      setPendingPlaidOpen(false);
      openPlaid();
      setStatus('Plaid window opened.');
      setBusy(null);
    }
  }, [openPlaid, pendingPlaidOpen, ready]);

  useEffect(() => {
    if (plaidLoadError) {
      setPendingPlaidOpen(false);
      setBusy(null);
      setStatus('Plaid could not load in this browser. Check content blockers and try again.');
    }
  }, [plaidLoadError]);

  useEffect(() => {
    if (!pendingPlaidOpen) return;
    const timeout = window.setTimeout(() => {
      setPendingPlaidOpen(false);
      setBusy(null);
      setStatus('Plaid did not finish loading. Check Plaid credentials and browser content blockers, then try again.');
    }, 15000);
    return () => window.clearTimeout(timeout);
  }, [pendingPlaidOpen]);

  if (!open) return null;

  const startPlaid = async () => {
    if (activePlaid >= 10) {
      setStatus('Plaid limit reached. Disconnect one before adding another.');
      return;
    }
    try {
      setBusy('plaid');
      setStatus('Preparing Plaid...');
      const token = await createPlaidLinkToken();
      setLinkToken(token.link_token);
      setStatus('Loading Plaid window...');
      setPendingPlaidOpen(true);
    } catch (error) {
      setBusy(null);
      setPendingPlaidOpen(false);
      setStatus(readableError(error));
    }
  };

  const startGmail = async () => {
    try {
      setBusy('gmail');
      setStatus('Opening Google...');
      const result = await getGmailOAuthUrl(businessId || undefined);
      if (!result.url) throw new Error('Google did not return an OAuth URL.');
      window.location.assign(result.url);
    } catch (error) {
      setBusy(null);
      setStatus(readableError(error));
    }
  };

  const refreshConnection = async (connection: Connection) => {
    if (!connection.id) return;
    setStatus(`Sync queued for ${connection.label}.`);
    await syncConnection(connection.id);
    onRefresh();
  };

  const backfillConnection = async (connection: Connection) => {
    if (!connection.id) return;
    setStatus(`Queued a 12-month history pull for ${connection.label}.`);
    await backfillPlaidConnection(connection.id, 12);
    setStatus('12-month pull queued. If this connection was created before 12-month history was enabled, reconnect it to expand the history window.');
    onRefresh();
  };

  const removeConnection = async (connection: Connection) => {
    if (!connection.id) return;
    setStatus(`Disconnected ${connection.label}.`);
    await disconnectConnection(connection.id);
    onRefresh();
  };

  const changeConnectionBusiness = async (connection: Connection, next: string) => {
    if (!connection.id) return;
    setStatus(`Updated default business for ${connection.label}.`);
    await updateConnectionBusiness(connection.id, next || null);
    onRefresh();
  };

  const changeAccountBusiness = async (account: Account, next: string, applyToExisting = false) => {
    setStatus(applyToExisting ? `Reassigning existing transactions for ${account.name}...` : `Updated default business for ${account.name}.`);
    await updateAccountBusiness(account.id, next || null, applyToExisting);
    setStatus(applyToExisting ? `Existing transactions reassigned for ${account.name}.` : `Future transactions for ${account.name} will use the selected business.`);
    onRefresh();
  };

  const changeAccountWatch = async (account: Account, enabled: boolean) => {
    setStatus(enabled ? `${account.name} is now watched.` : `${account.name} is ignored in spend results.`);
    await updateAccountEnabled(account.id, enabled);
    onRefresh();
  };

  return (
    <div style={backdropStyle}>
      <section style={modalStyle}>
        <header style={headerStyle}>
          <div style={logoMarkStyle}><PlugZap size={22} /></div>
          <div>
            <div style={{ fontFamily: fonts.display, fontSize: 28, fontWeight: 900 }}>Connections</div>
            <div style={{ color: colors.dim, fontSize: 12 }}>{activePlaid}/10 Plaid · {activeGmail} Gmail · {accounts.length} mapped accounts</div>
          </div>
          <span style={{ flex: 1 }} />
          {needsAttention > 0 && <StatusPill status="reauth" label={`${needsAttention} needs reauth`} />}
          <button type="button" onClick={onClose} style={iconButtonStyle} title="Close"><X size={18} /></button>
        </header>

        <div style={actionGridStyle}>
          <QuickAction
            icon={<CreditCard size={19} />}
            title="Plaid"
            detail={`${activePlaid}/10 active`}
            disabled={activePlaid >= 10 || Boolean(busy)}
            loading={busy === 'plaid'}
            onClick={startPlaid}
          />
          <QuickAction
            icon={<Mail size={19} />}
            title="Gmail"
            detail={`${activeGmail} inboxes`}
            disabled={Boolean(busy)}
            loading={busy === 'gmail'}
            onClick={startGmail}
          />
          <div style={defaultBusinessStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 900 }}>
              <Building2 size={17} />
              Default business
            </div>
            <BusinessSelect value={businessId} businesses={businesses} onChange={setBusinessId} includeAll={false} />
          </div>
        </div>

        {status && <div style={statusLineStyle}>{status}</div>}

        <div style={contentGridStyle}>
          <section style={panelStyle}>
            <SectionTitle title="Providers" count={connections.length} />
            <div style={{ display: 'grid', gap: 8 }}>
              {connections.length ? connections.map((connection) => (
                <ProviderRow
                  key={connection.id ?? connection.label}
                  connection={connection}
                  businesses={businesses}
                  onBusiness={(next) => changeConnectionBusiness(connection, next)}
                  onSync={() => refreshConnection(connection)}
                  onBackfill={connection.kind === 'gmail' ? undefined : () => backfillConnection(connection)}
                  onDisconnect={() => removeConnection(connection)}
                />
              )) : <Empty label="No provider connections yet." />}
            </div>
          </section>

          <section style={panelStyle}>
            <SectionTitle title="Accounts And Cards" count={accounts.length} />
            <div style={{ display: 'grid', gap: 8 }}>
              {accounts.length ? accounts.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  businesses={businesses}
                  onBusiness={(next, applyToExisting = false) => changeAccountBusiness(account, next, applyToExisting)}
                  onEnabled={(enabled) => changeAccountWatch(account, enabled)}
                />
              )) : <Empty label="Plaid accounts appear after the first sync." />}
            </div>
          </section>
        </div>
      </section>
    </div>
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
    <button type="button" disabled={disabled} onClick={onClick} style={{ ...quickActionStyle, opacity: disabled ? 0.45 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}>
      <span style={quickIconStyle}>{icon}</span>
      <span style={{ display: 'grid', textAlign: 'left' }}>
        <span style={{ fontWeight: 900 }}>{title}</span>
        <span style={{ fontSize: 11, color: colors.dim }}>{loading ? 'Working...' : detail}</span>
      </span>
    </button>
  );
}

function ProviderRow({
  connection,
  businesses,
  onBusiness,
  onSync,
  onBackfill,
  onDisconnect,
}: {
  connection: Connection;
  businesses: Business[];
  onBusiness: (businessId: string) => void;
  onSync: () => void;
  onBackfill?: () => void;
  onDisconnect: () => void;
}) {
  return (
    <div style={providerRowStyle}>
      <KindIcon kind={connection.kind} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 900, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{connection.label}</div>
        <div style={{ color: colors.dim, fontSize: 11 }}>{connection.last}</div>
      </div>
      <StatusPill status={connection.status} />
      <BusinessSelect value={connection.businessId ?? ''} businesses={businesses} onChange={onBusiness} />
      {onBackfill ? <button type="button" style={smallIconButtonStyle} onClick={onBackfill} title="Pull 12 months of Plaid history">12m</button> : <span />}
      <button type="button" style={iconButtonStyle} onClick={onSync} title="Sync"><RefreshCcw size={15} /></button>
      <button type="button" style={iconButtonStyle} onClick={onDisconnect} title="Disconnect"><Trash2 size={15} /></button>
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
    <div style={{ ...accountRowStyle, opacity: account.enabled ? 1 : 0.62 }}>
      <KindIcon kind={account.kind === 'credit' ? 'card' : 'bank'} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 900, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{account.name}</div>
        <div style={{ color: colors.dim, fontSize: 11 }}>
          {account.kind}{account.mask ? ` · ${account.mask}` : ''} · {account.enabled ? 'included in spend' : 'ignored in spend'}
        </div>
      </div>
      <BusinessSelect value={account.businessId ?? ''} businesses={businesses} onChange={(next) => onBusiness(next)} />
      <button
        type="button"
        disabled={!account.businessId}
        style={{ ...smallButtonStyle, opacity: account.businessId ? 1 : 0.45, cursor: account.businessId ? 'pointer' : 'not-allowed' }}
        onClick={() => onBusiness(account.businessId ?? '', true)}
      >
        Reassign existing
      </button>
      <label style={toggleStyle}>
        <input type="checkbox" checked={account.enabled} onChange={(event) => onEnabled(event.target.checked)} />
        {account.enabled ? 'Watched' : 'Ignored'}
      </label>
    </div>
  );
}

function BusinessSelect({
  value,
  businesses,
  onChange,
  includeAll = true,
}: {
  value: string;
  businesses: Business[];
  onChange: (value: string) => void;
  includeAll?: boolean;
}) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} style={selectStyle}>
      {includeAll && <option value="">Unassigned</option>}
      {businesses.map((business) => (
        <option key={business.dbId ?? business.id} value={business.dbId ?? business.id}>{business.name}</option>
      ))}
    </select>
  );
}

function KindIcon({ kind }: { kind: ConnectionKind }) {
  const icon = kind === 'gmail' ? <Mail size={16} /> : <CreditCard size={16} />;
  return <span style={kindIconStyle}>{icon}</span>;
}

function StatusPill({ status, label }: { status: ConnectionStatus; label?: string }) {
  const live = status === 'live';
  const palette = live
    ? { bg: colors.sage, fg: colors.sageInk, icon: <CheckCircle2 size={12} /> }
    : status === 'reauth'
      ? { bg: colors.pink, fg: colors.pinkInk, icon: <AlertTriangle size={12} /> }
      : { bg: colors.bg, fg: colors.dim, icon: <X size={12} /> };
  return (
    <span style={{ ...statusPillStyle, background: palette.bg, color: palette.fg }}>
      {palette.icon}
      {label ?? status}
    </span>
  );
}

function SectionTitle({ title, count }: { title: string; count: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
      <div style={{ fontFamily: fonts.display, fontSize: 18, fontWeight: 900 }}>{title}</div>
      <span style={{ color: colors.dim, fontSize: 12 }}>{count}</span>
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return <div style={{ color: colors.dim, fontSize: 13, padding: 14, background: colors.bg, borderRadius: radii.tile }}>{label}</div>;
}

const backdropStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 30,
  background: 'rgba(44,37,32,0.30)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 20,
};

const modalStyle: React.CSSProperties = {
  width: 'min(1120px, 100%)',
  maxHeight: '88vh',
  overflow: 'auto',
  background: colors.paper,
  color: colors.ink,
  borderRadius: radii.tile,
  padding: 18,
  display: 'grid',
  gap: 14,
  boxShadow: '0 26px 80px rgba(44,37,32,0.24)',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
};

const logoMarkStyle: React.CSSProperties = {
  width: 46,
  height: 46,
  borderRadius: 14,
  background: colors.ink,
  color: colors.lemon,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const actionGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '180px 180px minmax(260px, 1fr)',
  gap: 10,
};

const quickActionStyle: React.CSSProperties = {
  border: `1px solid ${colors.ink2}`,
  borderRadius: radii.tile,
  background: colors.bg,
  color: colors.ink,
  padding: 12,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};

const quickIconStyle: React.CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: 12,
  background: colors.ink,
  color: colors.lemon,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const defaultBusinessStyle: React.CSSProperties = {
  borderRadius: radii.tile,
  background: colors.bg,
  padding: 12,
  display: 'grid',
  gap: 8,
};

const contentGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(360px, 0.9fr) minmax(480px, 1.1fr)',
  gap: 14,
  alignItems: 'start',
};

const panelStyle: React.CSSProperties = {
  display: 'grid',
  gap: 10,
  alignContent: 'start',
};

const providerRowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '38px minmax(120px, 1fr) auto 160px 42px 34px 34px',
  gap: 8,
  alignItems: 'center',
  padding: 10,
  borderRadius: radii.tile,
  background: colors.bg,
};

const accountRowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '38px minmax(140px, 1fr) 180px auto 96px',
  gap: 8,
  alignItems: 'center',
  padding: 10,
  borderRadius: radii.tile,
  background: colors.bg,
};

const kindIconStyle: React.CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: 11,
  background: colors.paper,
  color: colors.ink,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const statusPillStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 5,
  borderRadius: radii.pill,
  padding: '5px 8px',
  fontSize: 11,
  fontWeight: 900,
  whiteSpace: 'nowrap',
};

const selectStyle: React.CSSProperties = {
  width: '100%',
  border: `1px solid ${colors.ink2}`,
  borderRadius: 10,
  background: colors.paper,
  color: colors.ink,
  padding: '8px 9px',
  fontSize: 12,
};

const smallButtonStyle: React.CSSProperties = {
  border: `1px solid ${colors.ink2}`,
  borderRadius: radii.pill,
  background: colors.paper,
  color: colors.ink,
  padding: '7px 10px',
  fontWeight: 900,
  cursor: 'pointer',
  fontSize: 11,
  whiteSpace: 'nowrap',
};

const iconButtonStyle: React.CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: '50%',
  border: `1px solid ${colors.ink2}`,
  background: colors.paper,
  color: colors.ink,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
};

const smallIconButtonStyle: React.CSSProperties = {
  ...iconButtonStyle,
  width: 42,
  borderRadius: radii.pill,
  fontSize: 11,
  fontWeight: 900,
};

const toggleStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  color: colors.dim,
  fontSize: 12,
  fontWeight: 800,
  whiteSpace: 'nowrap',
};

const statusLineStyle: React.CSSProperties = {
  color: colors.dim,
  fontSize: 12,
  background: colors.bg,
  borderRadius: radii.tile,
  padding: '8px 10px',
};
