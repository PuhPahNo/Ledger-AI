import { useRef } from 'react';
import { colors, fonts, radii } from '@/theme/tokens';

interface Props {
  onUploadReceipt: (file: File) => void;
  currentView?: 'dashboard' | 'admin';
  onViewChange?: (view: 'dashboard' | 'admin') => void;
  onLogout?: () => void;
}

export function HeaderBar({ onUploadReceipt, currentView = 'dashboard', onViewChange, onLogout }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '4px 8px' }}>
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: 12,
          background: colors.ink,
          color: colors.lemon,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: fonts.display,
          fontWeight: 700,
          fontSize: 18,
        }}
      >
        L
      </div>
      <div style={{ fontFamily: fonts.display, fontSize: 20, fontWeight: 600, letterSpacing: -0.5 }}>
        Ledger AI
      </div>
      <div
        style={{
          fontFamily: fonts.mono,
          fontSize: 11,
          color: colors.dim,
          marginLeft: 6,
          padding: '3px 8px',
          background: colors.paper,
          borderRadius: radii.pill,
        }}
      >
        internal · v0.4
      </div>
      <div style={{ flex: 1 }} />
      <div style={{ display: 'flex', gap: 6, background: colors.paper, borderRadius: radii.pill, padding: 3 }}>
        <NavButton active={currentView === 'dashboard'} onClick={() => onViewChange?.('dashboard')}>
          Dashboard
        </NavButton>
        <NavButton active={currentView === 'admin'} onClick={() => onViewChange?.('admin')}>
          Admin
        </NavButton>
      </div>
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '7px 12px',
          background: colors.paper,
          borderRadius: radii.pill,
          color: colors.dim,
          fontSize: 13,
          cursor: 'text',
        }}
      >
        <span style={{ opacity: 0.6 }}>⌘K</span>
        <span>Search transactions, receipts, rules…</span>
      </label>
      <div style={{ flex: 1 }} />
      <input
        ref={fileInput}
        type="file"
        accept="image/*,application/pdf"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onUploadReceipt(f);
          e.target.value = '';
        }}
      />
      <button
        type="button"
        onClick={() => fileInput.current?.click()}
        style={{
          padding: '8px 14px',
          borderRadius: radii.pill,
          background: colors.ink,
          color: colors.lemon,
          border: 'none',
          fontWeight: 600,
          fontSize: 13,
          cursor: 'pointer',
        }}
      >
        + Upload receipt
      </button>
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: '50%',
          background: colors.coral,
          color: colors.paper,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontWeight: 700,
        }}
      >
        N
      </div>
      {onLogout && (
        <button
          type="button"
          onClick={onLogout}
          style={{
            padding: '7px 10px',
            borderRadius: radii.pill,
            border: `1px solid ${colors.ink2}`,
            background: 'transparent',
            color: colors.ink2,
            cursor: 'pointer',
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          Logout
        </button>
      )}
    </div>
  );
}

function NavButton({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '5px 10px',
        borderRadius: radii.pill,
        border: 'none',
        background: active ? colors.ink : 'transparent',
        color: active ? colors.lemon : colors.dim,
        cursor: 'pointer',
        fontSize: 12,
        fontWeight: 700,
      }}
    >
      {children}
    </button>
  );
}
