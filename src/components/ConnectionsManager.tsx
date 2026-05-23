import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Building2, CheckCircle2, CreditCard, Mail, PlugZap, RefreshCcw, Trash2, X } from 'lucide-react';
import { usePlaidLink } from 'react-plaid-link';
import {
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
  const [status, setStatus] = useState('');
  const activePlaid = useMemo(() => connections.filter((c) => c.kind !== 'gmail' && c.status !== 'disconnected').length, [connections]);
  const activeGmail = useMemo(() => connections.filter((c) => c.kind === 'gmail' && c.status !== 'disconnected').length, [connections]);
  const needsAttention = connections.filter((c) => c.status === 'reauth').length;

  useEffect(() => {
    if (!businessId && firstBusiness) setBusinessId(firstBusiness);
  }, [businessId, firstBusiness]);

  const { open: openPlaid, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: async (publicToken) => {
      setStatus('Connecting Plaid...');
      await exchangePlaidPublicToken(publicToken, businessId || undefined);
      setStatus('Plaid connected.');
      onRefresh();
    },
  });

  useEffect(() => {
    if (pendingPlaidOpen && ready) {
      setPendingPlaidOpen(false);
      openPlaid();
    }
  }, [openPlaid, pendingPlaidOpen, ready]);

  if (!open) return null;

  const startPlaid = async () => {
    if (activePlaid >= 10) {
      setStatus('Plaid limit reached. Disconnect one before adding another.');
      return;
    }
    setStatus('Preparing Plaid...');
    const token = await createPlaidLinkToken();
    setLinkToken(token.link_token);
    setPendingPlaidOpen(true);
  };

  const startGmail = async () => {
    setStatus('Opening Google...');
    const result = await getGmailOAuthUrl(businessId || undefined);
    window.location.href = result.url;
  };

  const refreshConnection = async (connection: Connection) => {
    if (!connection.id) return;
    setStatus(`Sync queued for ${connection.label}.`);
    await syncConnection(connection.id);
    onRefresh();
  };

  const removeConnection = async (connection: Connection) => {
    if (!connection.id) return;
    setStatus(`Disconnected ${connection.label}.`);
    await disconnectConnection(connection.id);
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
            disabled={activePlaid >= 10}
            onClick={startPlaid}
          />
          <QuickAction
            icon={<Mail size={19} />}
            title="Gmail"
            detail={`${activeGmail} inboxes`}
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
                  onBusiness={(next) => connection.id && updateConnectionBusiness(connection.id, next || null).then(onRefresh)}
                  onSync={() => refreshConnection(connection)}
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
                  onBusiness={(next, applyToExisting = false) => updateAccountBusiness(account.id, next || null, applyToExisting).then(onRefresh)}
                  onEnabled={(enabled) => updateAccountEnabled(account.id, enabled).then(onRefresh)}
                />
              )) : <Empty label="Plaid accounts appear after the first sync." />}
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}

function QuickAction({ icon, title, detail, disabled = false, onClick }: { icon: React.ReactNode; title: string; detail: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} style={{ ...quickActionStyle, opacity: disabled ? 0.45 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}>
      <span style={quickIconStyle}>{icon}</span>
      <span style={{ display: 'grid', textAlign: 'left' }}>
        <span style={{ fontWeight: 900 }}>{title}</span>
        <span style={{ fontSize: 11, color: colors.dim }}>{detail}</span>
      </span>
    </button>
  );
}

function ProviderRow({
  connection,
  businesses,
  onBusiness,
  onSync,
  onDisconnect,
}: {
  connection: Connection;
  businesses: Business[];
  onBusiness: (businessId: string) => void;
  onSync: () => void;
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
    <div style={accountRowStyle}>
      <KindIcon kind={account.kind === 'credit' ? 'card' : 'bank'} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 900, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{account.name}</div>
        <div style={{ color: colors.dim, fontSize: 11 }}>{account.kind}{account.mask ? ` · ${account.mask}` : ''}</div>
      </div>
      <BusinessSelect value={account.businessId ?? ''} businesses={businesses} onChange={(next) => onBusiness(next)} />
      <button type="button" style={smallButtonStyle} onClick={() => onBusiness(account.businessId ?? '', true)}>Apply existing</button>
      <label style={toggleStyle}>
        <input type="checkbox" checked={account.enabled} onChange={(event) => onEnabled(event.target.checked)} />
        Enabled
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
  gridTemplateColumns: '38px minmax(120px, 1fr) auto 160px 34px 34px',
  gap: 8,
  alignItems: 'center',
  padding: 10,
  borderRadius: radii.tile,
  background: colors.bg,
};

const accountRowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '38px minmax(140px, 1fr) 180px auto auto',
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
