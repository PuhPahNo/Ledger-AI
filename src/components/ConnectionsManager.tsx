import { useEffect, useMemo, useState } from 'react';
import { RefreshCcw, Trash2, X } from 'lucide-react';
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
import type { Account, Business, Connection } from '@/types/domain';
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
  const firstBusiness = businesses[0]?.dbId ?? '';
  const [businessId, setBusinessId] = useState(firstBusiness);
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [pendingPlaidOpen, setPendingPlaidOpen] = useState(false);
  const [status, setStatus] = useState('');
  const activePlaid = useMemo(() => connections.filter((c) => c.kind !== 'gmail' && c.status !== 'disconnected').length, [connections]);

  useEffect(() => {
    if (!businessId && firstBusiness) setBusinessId(firstBusiness);
  }, [businessId, firstBusiness]);

  const { open: openPlaid, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: async (publicToken) => {
      setStatus('Connecting Plaid...');
      await exchangePlaidPublicToken(publicToken, businessId || undefined);
      setStatus('Plaid connection added.');
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

  const changeConnectionBusiness = async (connection: Connection, nextBusinessId: string) => {
    if (!connection.id) return;
    await updateConnectionBusiness(connection.id, nextBusinessId || null);
    onRefresh();
  };

  const changeAccountBusiness = async (account: Account, nextBusinessId: string, applyToExisting = false) => {
    await updateAccountBusiness(account.id, nextBusinessId || null, applyToExisting);
    onRefresh();
  };

  return (
    <div style={backdropStyle}>
      <section style={modalStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div>
            <div style={{ fontFamily: fonts.display, fontSize: 22, fontWeight: 800 }}>Connections</div>
            <div style={{ color: colors.dim, fontSize: 12 }}>Connect Plaid and Gmail, then map every account to a business.</div>
          </div>
          <span style={{ flex: 1 }} />
          <button type="button" onClick={onClose} style={iconButtonStyle} title="Close"><X size={18} /></button>
        </div>

        <div style={bandStyle}>
          <BusinessSelect value={businessId} businesses={businesses} onChange={setBusinessId} includeAll={false} />
          <button type="button" style={primaryButtonStyle} onClick={startPlaid} disabled={activePlaid >= 10}>
            Connect Plaid ({activePlaid}/10)
          </button>
          <button type="button" style={primaryButtonStyle} onClick={startGmail}>
            Connect Gmail
          </button>
        </div>
        {status && <div style={{ color: colors.dim, fontSize: 12 }}>{status}</div>}

        <div style={gridStyle}>
          <Panel title="Provider Connections">
            {connections.length ? connections.map((connection) => (
              <div key={connection.id ?? connection.label} style={rowStyle}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 800, fontSize: 13 }}>{connection.label}</div>
                  <div style={{ color: colors.dim, fontSize: 11 }}>{connection.kind} · {connection.status} · {connection.last}</div>
                </div>
                <BusinessSelect
                  value={connection.businessId ?? ''}
                  businesses={businesses}
                  onChange={(next) => changeConnectionBusiness(connection, next)}
                />
                <button type="button" style={iconButtonStyle} onClick={() => connection.id && syncConnection(connection.id).then(onRefresh)} title="Sync">
                  <RefreshCcw size={15} />
                </button>
                <button type="button" style={iconButtonStyle} onClick={() => connection.id && disconnectConnection(connection.id).then(onRefresh)} title="Disconnect">
                  <Trash2 size={15} />
                </button>
              </div>
            )) : <Empty label="No connections yet." />}
          </Panel>

          <Panel title="Plaid Accounts And Cards">
            {accounts.length ? accounts.map((account) => (
              <div key={account.id} style={rowStyle}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 800, fontSize: 13 }}>{account.name}</div>
                  <div style={{ color: colors.dim, fontSize: 11 }}>{account.kind} {account.mask ? `· ${account.mask}` : ''}</div>
                </div>
                <BusinessSelect
                  value={account.businessId ?? ''}
                  businesses={businesses}
                  onChange={(next) => changeAccountBusiness(account, next)}
                />
                <button
                  type="button"
                  style={smallButtonStyle}
                  onClick={() => changeAccountBusiness(account, account.businessId ?? '', true)}
                >
                  Apply existing
                </button>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: colors.dim }}>
                  <input
                    type="checkbox"
                    checked={account.enabled}
                    onChange={(event) => updateAccountEnabled(account.id, event.target.checked).then(onRefresh)}
                  />
                  Enabled
                </label>
              </div>
            )) : <Empty label="Plaid accounts appear after the first sync." />}
          </Panel>
        </div>
      </section>
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

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ display: 'grid', gap: 8, alignContent: 'start' }}>
      <div style={{ fontFamily: fonts.display, fontWeight: 800 }}>{title}</div>
      {children}
    </section>
  );
}

function Empty({ label }: { label: string }) {
  return <div style={{ color: colors.dim, fontSize: 13, padding: 14, background: colors.bg, borderRadius: radii.tile }}>{label}</div>;
}

const backdropStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 30,
  background: 'rgba(44,37,32,0.28)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 20,
};

const modalStyle: React.CSSProperties = {
  width: 'min(1060px, 100%)',
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

const bandStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  background: colors.bg,
  borderRadius: radii.tile,
  padding: 10,
};

const gridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 14,
};

const rowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(180px, 1fr) 190px auto auto',
  gap: 8,
  alignItems: 'center',
  padding: 10,
  borderRadius: radii.tile,
  background: colors.bg,
};

const selectStyle: React.CSSProperties = {
  width: '100%',
  border: `1px solid ${colors.ink2}`,
  borderRadius: 10,
  background: colors.paper,
  color: colors.ink,
  padding: '7px 9px',
  fontSize: 12,
};

const primaryButtonStyle: React.CSSProperties = {
  border: 'none',
  borderRadius: radii.pill,
  background: colors.ink,
  color: colors.lemon,
  padding: '8px 12px',
  fontWeight: 800,
  cursor: 'pointer',
};

const smallButtonStyle: React.CSSProperties = {
  border: `1px solid ${colors.ink2}`,
  borderRadius: radii.pill,
  background: 'transparent',
  color: colors.ink,
  padding: '7px 10px',
  fontWeight: 800,
  cursor: 'pointer',
  fontSize: 11,
};

const iconButtonStyle: React.CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: '50%',
  border: `1px solid ${colors.ink2}`,
  background: 'transparent',
  color: colors.ink,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
};
