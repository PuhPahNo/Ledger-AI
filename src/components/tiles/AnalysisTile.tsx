import { useMemo, useState } from 'react';
import type { Account, Business, Transaction } from '@/types/domain';
import { accentRamp, colors, fonts, radii } from '@/theme/tokens';
import { fmt$k } from '@/lib/format';
import { Tile } from './Tile';

type Mode = 'business' | 'category' | 'account' | 'receipt';

interface Props {
  businesses: Business[];
  accounts: Account[];
  transactions: Transaction[];
  onOpenTransactions: () => void;
}

export function AnalysisTile({ businesses, accounts, transactions, onOpenTransactions }: Props) {
  const [mode, setMode] = useState<Mode>('category');
  const rows = useMemo(() => groupRows(mode, transactions, businesses, accounts), [accounts, businesses, mode, transactions]);
  const max = Math.max(...rows.map((row) => row.amount), 1);
  const total = rows.reduce((sum, row) => sum + row.amount, 0);

  return (
    <Tile bg={colors.paper} ink={colors.ink} colSpan={2} rowSpan={2} pad={16} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <div>
          <div style={{ fontFamily: fonts.mono, fontSize: 10, letterSpacing: 1.2, color: colors.dim }}>ANALYSIS</div>
          <div style={{ fontFamily: fonts.display, fontSize: 20, fontWeight: 900 }}>Breakdowns</div>
        </div>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={onOpenTransactions} style={openButtonStyle}>View all</button>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
        <ModeButton active={mode === 'category'} onClick={() => setMode('category')}>Category</ModeButton>
        <ModeButton active={mode === 'account'} onClick={() => setMode('account')}>Account</ModeButton>
        <ModeButton active={mode === 'business'} onClick={() => setMode('business')}>Business</ModeButton>
        <ModeButton active={mode === 'receipt'} onClick={() => setMode('receipt')}>Receipts</ModeButton>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Metric label="Outflow" value={fmt$k(total)} />
        <Metric label="Rows" value={String(transactions.length)} />
      </div>

      <div style={{ display: 'grid', gap: 9, minHeight: 0 }}>
        {rows.slice(0, 7).map((row, index) => (
          <div key={row.label} style={{ display: 'grid', gap: 4 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 900, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {row.label}
              </span>
              <span style={{ color: colors.dim, fontSize: 10.5 }}>{row.count}</span>
              <span style={{ fontFamily: fonts.display, fontSize: 12.5, fontWeight: 900, fontVariantNumeric: 'tabular-nums' }}>{fmt$k(row.amount)}</span>
            </div>
            <div style={{ height: 8, borderRadius: radii.pill, background: colors.bg, overflow: 'hidden' }}>
              <div
                style={{
                  width: `${Math.max(4, (row.amount / max) * 100)}%`,
                  height: '100%',
                  borderRadius: radii.pill,
                  background: row.color ?? accentRamp[index % accentRamp.length],
                }}
              />
            </div>
          </div>
        ))}
        {!rows.length && <div style={{ color: colors.dim, fontSize: 12 }}>No spend matches the current filters.</div>}
      </div>
    </Tile>
  );
}

function groupRows(mode: Mode, transactions: Transaction[], businesses: Business[], accounts: Account[]) {
  const businessById = new Map(businesses.map((business) => [business.id, business]));
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const rows = new Map<string, { label: string; amount: number; count: number; color?: string }>();
  for (const transaction of transactions) {
    if (transaction.amount >= 0) continue;
    const business = businessById.get(transaction.biz);
    const account = transaction.accountId ? accountById.get(transaction.accountId) : undefined;
    const label = labelFor(mode, transaction, business, account);
    const color = mode === 'business' ? business?.color : undefined;
    const row = rows.get(label) ?? { label, amount: 0, count: 0, color };
    row.amount += Math.abs(transaction.amount);
    row.count += 1;
    rows.set(label, row);
  }
  return [...rows.values()].sort((a, b) => b.amount - a.amount);
}

function labelFor(mode: Mode, transaction: Transaction, business?: Business, account?: Account): string {
  switch (mode) {
    case 'business':
      return business?.name ?? transaction.biz;
    case 'account':
      return account?.name ?? transaction.src;
    case 'receipt':
      return transaction.receipt;
    default:
      return transaction.cat || 'Uncategorized';
  }
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: colors.bg, borderRadius: radii.tile, padding: '9px 10px' }}>
      <div style={{ color: colors.dim, fontFamily: fonts.mono, fontSize: 9.5, letterSpacing: 1 }}>{label}</div>
      <div style={{ fontFamily: fonts.display, fontSize: 18, fontWeight: 900 }}>{value}</div>
    </div>
  );
}

function ModeButton({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: 'none',
        borderRadius: radii.pill,
        background: active ? colors.ink : colors.bg,
        color: active ? colors.lemon : colors.dim,
        padding: '5px 8px',
        fontSize: 10.5,
        fontWeight: 900,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

const openButtonStyle: React.CSSProperties = {
  border: `1px solid ${colors.ink2}`,
  borderRadius: radii.pill,
  background: 'transparent',
  color: colors.ink,
  padding: '5px 9px',
  fontSize: 11,
  fontWeight: 900,
  cursor: 'pointer',
};
