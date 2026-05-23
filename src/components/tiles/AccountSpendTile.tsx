import { CreditCard, EyeOff, Landmark } from 'lucide-react';
import type { Account, Business, Transaction } from '@/types/domain';
import { colors, fonts, radii } from '@/theme/tokens';
import { fmt$k } from '@/lib/format';
import { Tile } from './Tile';

interface Props {
  accounts: Account[];
  businesses: Business[];
  transactions: Transaction[];
  selectedAccountIds: string[];
  onToggleAccount: (accountId: string) => void;
  onClearAccounts: () => void;
  onManageAccounts: () => void;
}

export function AccountSpendTile({
  accounts,
  businesses,
  transactions,
  selectedAccountIds,
  onToggleAccount,
  onClearAccounts,
  onManageAccounts,
}: Props) {
  const selected = new Set(selectedAccountIds);
  const spendByAccount = transactions.reduce<Record<string, { amount: number; count: number }>>((acc, txn) => {
    if (!txn.accountId || txn.amount >= 0) return acc;
    const row = acc[txn.accountId] ?? { amount: 0, count: 0 };
    row.amount += Math.abs(txn.amount);
    row.count += 1;
    acc[txn.accountId] = row;
    return acc;
  }, {});
  const watched = accounts.filter((account) => account.enabled).length;
  const ignored = accounts.length - watched;
  const sortedAccounts = [...accounts].sort((a, b) => {
    const selectedDelta = Number(selected.has(b.id)) - Number(selected.has(a.id));
    if (selectedDelta !== 0) return selectedDelta;
    const enabledDelta = Number(b.enabled) - Number(a.enabled);
    if (enabledDelta !== 0) return enabledDelta;
    return (spendByAccount[b.id]?.amount ?? 0) - (spendByAccount[a.id]?.amount ?? 0);
  });

  return (
    <Tile
      bg={colors.paper}
      ink={colors.ink}
      colSpan={2}
      rowSpan={1}
      pad={14}
      style={{ display: 'flex', flexDirection: 'column', gap: 9 }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <div style={{ fontFamily: fonts.display, fontSize: 15, fontWeight: 800 }}>Spend By Account</div>
        <span style={{ color: colors.dim, fontSize: 11 }}>{selected.size ? `${selected.size} selected` : `${watched} watched`}</span>
        <span style={{ flex: 1 }} />
        {selected.size > 0 && <button type="button" onClick={onClearAccounts} style={ghostButtonStyle}>All</button>}
        <button type="button" onClick={onManageAccounts} style={ghostButtonStyle}>Manage</button>
      </div>

      <div style={{ display: 'grid', gap: 7, minHeight: 0 }}>
        {sortedAccounts.length ? sortedAccounts.slice(0, 4).map((account) => {
          const spend = spendByAccount[account.id] ?? { amount: 0, count: 0 };
          const active = selected.has(account.id);
          const business = businesses.find((item) => item.id === account.biz || item.dbId === account.businessId);
          return (
            <button
              key={account.id}
              type="button"
              disabled={!account.enabled}
              onClick={() => onToggleAccount(account.id)}
              title={account.enabled ? `Filter spend to ${account.name}` : `${account.name} is ignored in spend results`}
              style={{
                ...accountButtonStyle,
                borderColor: active ? colors.ink : colors.ink2,
                background: active ? colors.lemon : colors.bg,
                opacity: account.enabled ? 1 : 0.52,
                cursor: account.enabled ? 'pointer' : 'not-allowed',
              }}
            >
              <span style={iconStyle}>
                {account.enabled ? account.kind === 'credit' ? <CreditCard size={14} /> : <Landmark size={14} /> : <EyeOff size={14} />}
              </span>
              <span style={{ minWidth: 0, textAlign: 'left' }}>
                <span style={{ display: 'block', fontSize: 12, fontWeight: 900, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {account.name}
                </span>
                <span style={{ display: 'block', color: colors.dim, fontSize: 10.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {account.mask ?? account.kind} · {business?.short ?? 'Unassigned'} · {account.enabled ? `${spend.count} txns` : 'ignored'}
                </span>
              </span>
              <span style={{ fontFamily: fonts.display, fontWeight: 900, fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
                {account.enabled ? selected.size > 0 && !active ? 'View' : fmt$k(spend.amount) : 'Ignored'}
              </span>
            </button>
          );
        }) : (
          <div style={{ color: colors.dim, fontSize: 12, padding: '8px 0' }}>Connected Plaid accounts will appear here.</div>
        )}
      </div>

      {ignored > 0 && (
        <div style={{ color: colors.dim, fontSize: 10.5 }}>
          {ignored} ignored account{ignored === 1 ? '' : 's'} excluded from spend totals.
        </div>
      )}
    </Tile>
  );
}

const accountButtonStyle: React.CSSProperties = {
  border: `1px solid ${colors.ink2}`,
  borderRadius: radii.tile,
  color: colors.ink,
  padding: '7px 9px',
  display: 'grid',
  gridTemplateColumns: '28px minmax(0, 1fr) auto',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
};

const iconStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 9,
  background: colors.paper,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const ghostButtonStyle: React.CSSProperties = {
  border: `1px solid ${colors.ink2}`,
  borderRadius: radii.pill,
  background: 'transparent',
  color: colors.ink,
  padding: '4px 8px',
  fontSize: 10.5,
  fontWeight: 900,
  cursor: 'pointer',
};
