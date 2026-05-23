import { useEffect, useMemo, useState } from 'react';
import { ArrowDownUp, X } from 'lucide-react';
import { listTransactions } from '@/api';
import type { Account, Business, Category, ReceiptStatus, Transaction } from '@/types/domain';
import { colors, fonts, radii } from '@/theme/tokens';
import { fmt$, fmt$k } from '@/lib/format';

type SortKey = 'date' | 'amount' | 'merchant' | 'business' | 'category' | 'account';

interface Props {
  open: boolean;
  businesses: Business[];
  accounts: Account[];
  categories: Category[];
  initialBusiness: string;
  initialAccountIds: string[];
  initialQuery: string;
  onClose: () => void;
  onSelect: (transaction: Transaction) => void;
}

const receiptOptions: ReceiptStatus[] = ['missing', 'pending', 'matched', 'n/a'];

export function TransactionExplorer({
  open,
  businesses,
  accounts,
  categories,
  initialBusiness,
  initialAccountIds,
  initialQuery,
  onClose,
  onSelect,
}: Props) {
  const [business, setBusiness] = useState(initialBusiness);
  const [accountIds, setAccountIds] = useState<string[]>(initialAccountIds);
  const [categoryNames, setCategoryNames] = useState<string[]>([]);
  const [receipts, setReceipts] = useState<ReceiptStatus[]>([]);
  const [query, setQuery] = useState(initialQuery);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sort, setSort] = useState<SortKey>('date');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [rows, setRows] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setBusiness(initialBusiness);
    setAccountIds(initialAccountIds);
    setQuery(initialQuery);
  }, [initialAccountIds, initialBusiness, initialQuery, open]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError('');
    listTransactions({
      biz: business,
      accountIds,
      categories: categoryNames,
      receipts,
      q: query || undefined,
      from: from || undefined,
      to: to || undefined,
      sort,
      dir,
      limit: 1000,
    })
      .then(setRows)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [accountIds, business, categoryNames, dir, from, open, query, receipts, sort, to]);

  const businessById = useMemo(() => new Map(businesses.map((item) => [item.id, item])), [businesses]);
  const accountById = useMemo(() => new Map(accounts.map((item) => [item.id, item])), [accounts]);
  const outflow = rows.filter((row) => row.amount < 0).reduce((sum, row) => sum + Math.abs(row.amount), 0);
  const missing = rows.filter((row) => row.receipt === 'missing').length;
  const visibleAccounts = business === 'all' ? accounts : accounts.filter((account) => account.biz === business);
  const topCategories = categories.slice(0, 12);

  if (!open) return null;

  const toggleSort = (key: SortKey) => {
    if (sort === key) setDir((current) => (current === 'asc' ? 'desc' : 'asc'));
    else {
      setSort(key);
      setDir(key === 'merchant' ? 'asc' : 'desc');
    }
  };

  return (
    <div style={backdropStyle}>
      <section style={modalStyle}>
        <header style={headerStyle}>
          <div>
            <div style={{ fontFamily: fonts.display, fontSize: 30, fontWeight: 900 }}>Transactions</div>
            <div style={{ color: colors.dim, fontSize: 12 }}>Filter, sort, and inspect all synced spend rows.</div>
          </div>
          <span style={{ flex: 1 }} />
          <Metric label="Outflow" value={fmt$k(outflow)} />
          <Metric label="Rows" value={String(rows.length)} />
          <Metric label="Missing" value={String(missing)} />
          <button type="button" onClick={onClose} style={iconButtonStyle} title="Close"><X size={18} /></button>
        </header>

        <div style={filtersStyle}>
          <label style={fieldStyle}>
            Business
            <select value={business} onChange={(event) => { setBusiness(event.target.value); setAccountIds([]); }} style={inputStyle}>
              <option value="all">All</option>
              {businesses.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label style={fieldStyle}>
            Search
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Merchant, note, category" style={inputStyle} />
          </label>
          <label style={fieldStyle}>
            From
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} style={inputStyle} />
          </label>
          <label style={fieldStyle}>
            To
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} style={inputStyle} />
          </label>
          <button type="button" onClick={() => { setAccountIds([]); setCategoryNames([]); setReceipts([]); setQuery(''); setFrom(''); setTo(''); }} style={clearButtonStyle}>
            Clear filters
          </button>
        </div>

        <div style={chipPanelStyle}>
          <ChipGroup label="Accounts">
            {visibleAccounts.map((account) => (
              <Chip
                key={account.id}
                active={accountIds.includes(account.id)}
                muted={!account.enabled}
                onClick={() => toggle(account.id, accountIds, setAccountIds)}
              >
                {account.name}{account.mask ? ` ${account.mask}` : ''}
              </Chip>
            ))}
          </ChipGroup>
          <ChipGroup label="Categories">
            {topCategories.map((category) => (
              <Chip key={category.name} active={categoryNames.includes(category.name)} onClick={() => toggle(category.name, categoryNames, setCategoryNames)}>
                {category.name}
              </Chip>
            ))}
          </ChipGroup>
          <ChipGroup label="Receipts">
            {receiptOptions.map((receipt) => (
              <Chip key={receipt} active={receipts.includes(receipt)} onClick={() => toggle(receipt, receipts, setReceipts)}>
                {receipt}
              </Chip>
            ))}
          </ChipGroup>
        </div>

        {error && <div style={{ color: colors.coralInk, fontSize: 12 }}>{error}</div>}

        <div style={tableWrapStyle}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <Th active={sort === 'date'} dir={dir} onClick={() => toggleSort('date')}>Date</Th>
                <Th active={sort === 'merchant'} dir={dir} onClick={() => toggleSort('merchant')}>Merchant</Th>
                <Th active={sort === 'business'} dir={dir} onClick={() => toggleSort('business')}>Business</Th>
                <Th active={sort === 'account'} dir={dir} onClick={() => toggleSort('account')}>Account</Th>
                <Th active={sort === 'category'} dir={dir} onClick={() => toggleSort('category')}>Category</Th>
                <Th active={sort === 'amount'} dir={dir} onClick={() => toggleSort('amount')} align="right">Amount</Th>
                <th style={plainThStyle}>Receipt</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((transaction) => {
                const b = businessById.get(transaction.biz);
                const account = transaction.accountId ? accountById.get(transaction.accountId) : undefined;
                return (
                  <tr key={transaction.id} onClick={() => onSelect(transaction)} style={{ cursor: 'pointer' }}>
                    <td style={tdStyle}>{transaction.date}</td>
                    <td style={{ ...tdStyle, fontWeight: 900 }}>{transaction.merchant}</td>
                    <td style={tdStyle}>{b?.name ?? transaction.biz}</td>
                    <td style={tdStyle}>{account?.name ?? transaction.src}</td>
                    <td style={tdStyle}>{transaction.cat}</td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontFamily: fonts.display, fontWeight: 900 }}>{fmt$(transaction.amount)}</td>
                    <td style={tdStyle}><ReceiptPill status={transaction.receipt} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {loading && <div style={emptyStyle}>Loading transactions...</div>}
          {!loading && !rows.length && <div style={emptyStyle}>No transactions match these filters.</div>}
        </div>
      </section>
    </div>
  );
}

function toggle<T>(value: T, values: T[], setter: (values: T[]) => void) {
  setter(values.includes(value) ? values.filter((item) => item !== value) : [...values, value]);
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: colors.bg, borderRadius: radii.tile, padding: '8px 11px', minWidth: 82 }}>
      <div style={{ color: colors.dim, fontFamily: fonts.mono, fontSize: 9.5, letterSpacing: 1 }}>{label}</div>
      <div style={{ fontFamily: fonts.display, fontSize: 18, fontWeight: 900 }}>{value}</div>
    </div>
  );
}

function ChipGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div style={{ color: colors.dim, fontFamily: fonts.mono, fontSize: 9.5, letterSpacing: 1.1 }}>{label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>{children}</div>
    </div>
  );
}

function Chip({ active, muted, children, onClick }: { active: boolean; muted?: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: `1px solid ${active ? colors.ink : colors.ink2}`,
        borderRadius: radii.pill,
        background: active ? colors.lemon : colors.bg,
        color: muted ? colors.dim : colors.ink,
        padding: '5px 8px',
        fontSize: 10.5,
        fontWeight: 900,
        cursor: 'pointer',
        opacity: muted ? 0.62 : 1,
      }}
    >
      {children}
    </button>
  );
}

function Th({ active, dir, align, children, onClick }: { active: boolean; dir: 'asc' | 'desc'; align?: 'right'; children: React.ReactNode; onClick: () => void }) {
  return (
    <th style={{ ...plainThStyle, textAlign: align ?? 'left' }}>
      <button type="button" onClick={onClick} style={thButtonStyle}>
        {children}
        {active && <ArrowDownUp size={12} style={{ transform: dir === 'asc' ? 'rotate(180deg)' : undefined }} />}
      </button>
    </th>
  );
}

function ReceiptPill({ status }: { status: ReceiptStatus }) {
  const palette = status === 'missing'
    ? { bg: colors.coral, fg: colors.coralInk }
    : status === 'matched'
      ? { bg: colors.sage, fg: colors.sageInk }
      : { bg: colors.lemon, fg: colors.lemonInk };
  return <span style={{ borderRadius: radii.pill, padding: '3px 7px', background: palette.bg, color: palette.fg, fontSize: 10.5, fontWeight: 900 }}>{status}</span>;
}

const backdropStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 40,
  background: 'rgba(44,37,32,0.34)',
  padding: 22,
};

const modalStyle: React.CSSProperties = {
  width: '100%',
  height: '100%',
  background: colors.paper,
  borderRadius: radii.tile,
  color: colors.ink,
  padding: 18,
  display: 'grid',
  gridTemplateRows: 'auto auto auto auto minmax(0, 1fr)',
  gap: 12,
  boxShadow: '0 30px 90px rgba(44,37,32,0.24)',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};

const filtersStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '180px minmax(240px, 1fr) 150px 150px auto',
  gap: 8,
  alignItems: 'end',
};

const fieldStyle: React.CSSProperties = {
  display: 'grid',
  gap: 4,
  color: colors.dim,
  fontSize: 10.5,
  fontWeight: 900,
};

const inputStyle: React.CSSProperties = {
  border: `1px solid ${colors.ink2}`,
  borderRadius: 10,
  background: colors.bg,
  color: colors.ink,
  padding: '8px 9px',
  fontSize: 12,
};

const clearButtonStyle: React.CSSProperties = {
  border: `1px solid ${colors.ink2}`,
  borderRadius: radii.pill,
  background: 'transparent',
  color: colors.ink,
  padding: '8px 10px',
  fontSize: 11,
  fontWeight: 900,
  cursor: 'pointer',
};

const chipPanelStyle: React.CSSProperties = {
  display: 'grid',
  gap: 10,
  background: colors.bg,
  borderRadius: radii.tile,
  padding: 10,
};

const tableWrapStyle: React.CSSProperties = {
  minHeight: 0,
  overflow: 'auto',
  borderRadius: radii.tile,
  border: `1px solid ${colors.ink2}`,
};

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 12,
};

const plainThStyle: React.CSSProperties = {
  position: 'sticky',
  top: 0,
  zIndex: 1,
  background: colors.ink,
  color: colors.cream,
  padding: '9px 10px',
};

const thButtonStyle: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  padding: 0,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  fontWeight: 900,
  cursor: 'pointer',
};

const tdStyle: React.CSSProperties = {
  padding: '9px 10px',
  borderBottom: '1px solid rgba(44,37,32,0.08)',
  verticalAlign: 'middle',
};

const emptyStyle: React.CSSProperties = {
  padding: 18,
  color: colors.dim,
  fontSize: 13,
};

const iconButtonStyle: React.CSSProperties = {
  width: 38,
  height: 38,
  borderRadius: '50%',
  border: `1px solid ${colors.ink2}`,
  background: colors.paper,
  color: colors.ink,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
};
