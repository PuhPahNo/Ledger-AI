import { useEffect, useState } from 'react';
import { createExport, getAdminOverview, type AdminOverview } from '@/api';
import { colors, fonts, radii } from '@/theme/tokens';
import { HeaderBar } from '../HeaderBar';

interface Props {
  onViewChange?: (view: 'dashboard' | 'admin') => void;
  onLogout?: () => void;
}

export function AdminPage({ onViewChange, onLogout }: Props) {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [status, setStatus] = useState<string>('');

  useEffect(() => {
    getAdminOverview().then(setData).catch((err: Error) => setStatus(err.message));
  }, []);

  const runExport = async () => {
    setStatus('Creating export...');
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const to = now.toISOString().slice(0, 10);
    const job = await createExport(from, to);
    setStatus(`Export queued: ${job.id}`);
  };

  return (
    <div style={{ minHeight: '100vh', background: colors.bg, color: colors.ink, fontFamily: fonts.sans, padding: 14 }}>
      <HeaderBar onUploadReceipt={() => undefined} currentView="admin" onViewChange={onViewChange} onLogout={onLogout} />
      <main style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', marginTop: 10 }}>
        <Panel title="Businesses" span={4}>
          {data?.businesses.map((b) => (
            <Row key={b.id} left={b.name} right={b.active ? 'active' : 'off'} />
          ))}
        </Panel>
        <Panel title="Categories" span={4}>
          {data?.categories.slice(0, 10).map((c) => (
            <Row key={c.id} left={c.name} right={c.taxCode ?? 'tax'} />
          ))}
        </Panel>
        <Panel title="Users" span={4}>
          {data?.users.map((u) => (
            <Row key={u.id} left={u.displayName} right={u.totpEnabled ? '2FA' : 'password'} />
          ))}
        </Panel>
        <Panel title="Accounts" span={6}>
          {data?.accounts.map((a) => (
            <Row key={a.id} left={a.name} right={a.enabled ? a.kind : 'disabled'} />
          ))}
        </Panel>
        <Panel title="Rules" span={6}>
          {data?.rules.length ? data.rules.map((r) => (
            <Row key={r.id} left={`${r.matchKind}: ${r.pattern}`} right={`p${r.priority}`} />
          )) : <div style={{ color: colors.dim, fontSize: 13 }}>No category rules yet.</div>}
        </Panel>
        <Panel title="Audit Exports" span={12}>
          <button onClick={runExport} style={buttonStyle}>Queue month-to-date audit export</button>
          {status && <span style={{ marginLeft: 10, color: colors.dim, fontSize: 13 }}>{status}</span>}
          {data?.exports.map((e) => (
            <Row key={e.id} left={`${e.dateFrom} to ${e.dateTo}`} right={e.status} />
          ))}
        </Panel>
      </main>
    </div>
  );
}

function Panel({ title, span, children }: { title: string; span: number; children: React.ReactNode }) {
  return (
    <section
      style={{
        gridColumn: `span ${span}`,
        minHeight: 160,
        background: colors.paper,
        borderRadius: radii.tile,
        padding: 16,
      }}
    >
      <div style={{ fontFamily: fonts.display, fontWeight: 700, marginBottom: 10 }}>{title}</div>
      <div style={{ display: 'grid', gap: 8 }}>{children}</div>
    </section>
  );
}

function Row({ left, right }: { left: string; right: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13 }}>
      <span>{left}</span>
      <span style={{ color: colors.dim }}>{right}</span>
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  border: 'none',
  borderRadius: radii.pill,
  background: colors.ink,
  color: colors.lemon,
  padding: '9px 13px',
  fontWeight: 800,
  cursor: 'pointer',
};
