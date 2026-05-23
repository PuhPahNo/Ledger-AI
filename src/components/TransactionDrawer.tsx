import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { updateTransaction } from '@/api';
import { fmt$ } from '@/lib/format';
import { colors, fonts, radii } from '@/theme/tokens';
import type { Business, Category, Transaction } from '@/types/domain';

interface Props {
  transaction: Transaction | null;
  businesses: Business[];
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
}

export function TransactionDrawer({ transaction, businesses, categories, onClose, onSaved }: Props) {
  const resolvedBusinessId = useMemo(() => {
    if (!transaction) return '';
    return transaction.businessId ?? businesses.find((business) => business.id === transaction.biz)?.dbId ?? '';
  }, [businesses, transaction]);
  const [businessId, setBusinessId] = useState('');
  const [categoryId, setCategoryId] = useState<string>('');
  const [note, setNote] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    setBusinessId(resolvedBusinessId);
    setCategoryId(transaction?.categoryId ?? '');
    setNote(transaction?.note ?? '');
    setStatus('');
  }, [resolvedBusinessId, transaction]);

  if (!transaction) return null;

  const save = async () => {
    setStatus('Saving...');
    await updateTransaction(transaction.id, {
      businessId: businessId || undefined,
      categoryId: categoryId || null,
      note: note || null,
    });
    setStatus('Saved.');
    onSaved();
  };

  return (
    <aside style={drawerStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div>
          <div style={{ color: colors.dim, fontSize: 11, fontWeight: 800 }}>{transaction.dateLabel}</div>
          <div style={{ fontFamily: fonts.display, fontSize: 24, fontWeight: 800 }}>{transaction.merchant}</div>
        </div>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={onClose} style={iconButtonStyle} title="Close"><X size={18} /></button>
      </div>

      <div style={amountStyle}>{fmt$(transaction.amount)}</div>

      <label style={labelStyle}>Business</label>
      <select value={businessId} onChange={(event) => setBusinessId(event.target.value)} style={inputStyle}>
        {businesses.map((business) => (
          <option key={business.dbId ?? business.id} value={business.dbId ?? business.id}>{business.name}</option>
        ))}
      </select>

      <label style={labelStyle}>Category</label>
      <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)} style={inputStyle}>
        <option value="">Uncategorized</option>
        {categories.map((category) => (
          <option key={category.id ?? category.name} value={category.id ?? ''}>{category.name}</option>
        ))}
      </select>

      <label style={labelStyle}>Receipt</label>
      <div style={readonlyStyle}>{transaction.receipt}</div>

      <label style={labelStyle}>Source</label>
      <div style={readonlyStyle}>{transaction.src}</div>

      <label style={labelStyle}>Note</label>
      <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={4} style={{ ...inputStyle, resize: 'vertical' }} />

      <button type="button" onClick={save} style={saveButtonStyle}>Save overrides</button>
      {status && <div style={{ color: colors.dim, fontSize: 12 }}>{status}</div>}
    </aside>
  );
}

const drawerStyle: React.CSSProperties = {
  position: 'fixed',
  right: 0,
  top: 0,
  bottom: 0,
  width: 380,
  zIndex: 25,
  background: colors.paper,
  borderLeft: `1px solid ${colors.ink2}`,
  boxShadow: '-18px 0 50px rgba(44,37,32,0.16)',
  padding: 18,
  display: 'grid',
  alignContent: 'start',
  gap: 10,
  color: colors.ink,
};

const amountStyle: React.CSSProperties = {
  fontFamily: fonts.display,
  fontSize: 34,
  fontWeight: 900,
  margin: '4px 0 8px',
};

const labelStyle: React.CSSProperties = { fontSize: 11, fontWeight: 900, color: colors.dim };
const inputStyle: React.CSSProperties = {
  border: `1px solid ${colors.ink2}`,
  borderRadius: 10,
  background: colors.bg,
  color: colors.ink,
  padding: '9px 10px',
  fontSize: 13,
};
const readonlyStyle: React.CSSProperties = {
  ...inputStyle,
  background: colors.paper,
  color: colors.dim,
};
const saveButtonStyle: React.CSSProperties = {
  marginTop: 8,
  border: 'none',
  borderRadius: radii.pill,
  background: colors.ink,
  color: colors.lemon,
  padding: '10px 12px',
  fontWeight: 900,
  cursor: 'pointer',
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
