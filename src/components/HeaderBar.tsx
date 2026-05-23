import { useRef, useState } from 'react';
import { KeyRound, LogOut, Search, ShieldCheck, Upload, UserRound } from 'lucide-react';
import type { Business, CurrentUser } from '@/types/domain';
import { colors, fonts, radii } from '@/theme/tokens';
import { enableTotp, resetAdminUserPassword, setupTotp } from '@/api';

interface Props {
  onUploadReceipt: (file: File) => void;
  currentView?: 'dashboard' | 'admin';
  onViewChange?: (view: 'dashboard' | 'admin') => void;
  onLogout?: () => void;
  user?: CurrentUser;
  businesses?: Business[];
  selectedBusiness?: string;
  onBusinessChange?: (business: string) => void;
  query?: string;
  onQueryChange?: (query: string) => void;
}

export function HeaderBar({
  onUploadReceipt,
  currentView = 'dashboard',
  onViewChange,
  onLogout,
  user,
  businesses = [],
  selectedBusiness = 'all',
  onBusinessChange,
  query = '',
  onQueryChange,
}: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [totp, setTotp] = useState<{ qrDataUrl: string; code: string } | null>(null);
  const [status, setStatus] = useState('');

  const resetPassword = async () => {
    if (!user || newPassword.length < 12) {
      setStatus('Password must be at least 12 characters.');
      return;
    }
    try {
      await resetAdminUserPassword(user.id, newPassword);
      setNewPassword('');
      setStatus('Password updated. Use it the next time you log in.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Password update failed.');
    }
  };

  const startTotp = async () => {
    const result = await setupTotp();
    setTotp({ qrDataUrl: result.qrDataUrl, code: '' });
    setStatus('');
  };

  const confirmTotp = async () => {
    if (!totp?.code) return;
    await enableTotp(totp.code);
    setStatus('Two-factor auth enabled.');
    setTotp(null);
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '4px 8px', position: 'relative' }}>
      <div style={logoStyle}>L</div>
      <div style={{ fontFamily: fonts.display, fontSize: 20, fontWeight: 600 }}>
        Ledger AI
      </div>
      <div style={versionStyle}>internal v1</div>

      <div style={{ display: 'flex', gap: 6, background: colors.paper, borderRadius: radii.pill, padding: 3 }}>
        <NavButton active={currentView === 'dashboard'} onClick={() => onViewChange?.('dashboard')}>Dashboard</NavButton>
        <NavButton active={currentView === 'admin'} onClick={() => onViewChange?.('admin')}>Admin</NavButton>
      </div>

      {currentView === 'dashboard' && (
        <div style={{ display: 'flex', gap: 4, background: colors.paper, borderRadius: radii.pill, padding: 3 }}>
          <FilterButton active={selectedBusiness === 'all'} onClick={() => onBusinessChange?.('all')}>All</FilterButton>
          {businesses.map((business) => (
            <FilterButton key={business.id} active={selectedBusiness === business.id} onClick={() => onBusinessChange?.(business.id)}>
              {business.short}
            </FilterButton>
          ))}
        </div>
      )}

      <label style={searchStyle}>
        <Search size={15} />
        <input
          value={query}
          onChange={(event) => onQueryChange?.(event.target.value)}
          placeholder="Search merchants, categories, notes"
          style={{
            width: 270,
            border: 'none',
            outline: 'none',
            background: 'transparent',
            color: colors.ink,
            fontSize: 13,
            fontFamily: fonts.sans,
          }}
        />
      </label>

      <span style={{ flex: 1 }} />

      <input
        ref={fileInput}
        type="file"
        accept="image/*,application/pdf"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onUploadReceipt(file);
          event.target.value = '';
        }}
      />
      <button type="button" onClick={() => fileInput.current?.click()} style={primaryButtonStyle} title="Upload receipt">
        <Upload size={15} />
        Upload
      </button>

      <button
        type="button"
        onClick={() => setMenuOpen((open) => !open)}
        style={profileButtonStyle}
        title="Profile settings"
      >
        {(user?.displayName || user?.username || 'A').slice(0, 1).toUpperCase()}
      </button>

      {menuOpen && (
        <div style={menuStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <UserRound size={16} />
            <div>
              <div style={{ fontWeight: 800 }}>{user?.displayName ?? 'Admin'}</div>
              <div style={{ fontSize: 11, color: colors.dim }}>{user?.username}</div>
            </div>
          </div>

          <div style={dividerStyle} />
          <div style={{ display: 'grid', gap: 8 }}>
            <label style={labelStyle}>Reset password</label>
            <input
              type="password"
              value={newPassword}
              placeholder="12+ character password"
              onChange={(event) => setNewPassword(event.target.value)}
              style={inputStyle}
            />
            <button type="button" style={secondaryActionStyle} onClick={resetPassword}>
              <KeyRound size={14} />
              Update password
            </button>
          </div>

          <div style={dividerStyle} />
          {!totp ? (
            <button type="button" style={secondaryActionStyle} onClick={startTotp}>
              <ShieldCheck size={14} />
              Set up 2FA
            </button>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {totp.qrDataUrl && <img src={totp.qrDataUrl} alt="TOTP QR code" style={{ width: 132, height: 132, justifySelf: 'center' }} />}
              <input
                value={totp.code}
                onChange={(event) => setTotp({ ...totp, code: event.target.value })}
                placeholder="Authenticator code"
                style={inputStyle}
              />
              <button type="button" style={secondaryActionStyle} onClick={confirmTotp}>
                Enable 2FA
              </button>
            </div>
          )}

          {status && <div style={{ color: colors.dim, fontSize: 11 }}>{status}</div>}
          {onLogout && (
            <button type="button" onClick={onLogout} style={{ ...secondaryActionStyle, color: colors.coralInk }}>
              <LogOut size={14} />
              Logout
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function NavButton({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} style={{
      padding: '5px 10px',
      borderRadius: radii.pill,
      border: 'none',
      background: active ? colors.ink : 'transparent',
      color: active ? colors.lemon : colors.dim,
      cursor: 'pointer',
      fontSize: 12,
      fontWeight: 700,
    }}>{children}</button>
  );
}

function FilterButton({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} style={{
      minWidth: 32,
      padding: '5px 9px',
      borderRadius: radii.pill,
      border: 'none',
      background: active ? colors.lemon : 'transparent',
      color: active ? colors.lemonInk : colors.dim,
      cursor: 'pointer',
      fontSize: 11,
      fontWeight: 800,
    }}>{children}</button>
  );
}

const logoStyle: React.CSSProperties = {
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
};

const versionStyle: React.CSSProperties = {
  fontFamily: fonts.mono,
  fontSize: 11,
  color: colors.dim,
  padding: '3px 8px',
  background: colors.paper,
  borderRadius: radii.pill,
};

const searchStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '7px 12px',
  background: colors.paper,
  borderRadius: radii.pill,
  color: colors.dim,
};

const primaryButtonStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  padding: '8px 13px',
  borderRadius: radii.pill,
  background: colors.ink,
  color: colors.lemon,
  border: 'none',
  fontWeight: 700,
  fontSize: 13,
  cursor: 'pointer',
};

const profileButtonStyle: React.CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: '50%',
  background: colors.coral,
  color: colors.paper,
  border: 'none',
  fontWeight: 800,
  cursor: 'pointer',
};

const menuStyle: React.CSSProperties = {
  position: 'absolute',
  right: 8,
  top: 48,
  width: 280,
  zIndex: 20,
  background: colors.paper,
  color: colors.ink,
  border: `1px solid ${colors.ink2}`,
  borderRadius: radii.tile,
  boxShadow: '0 18px 50px rgba(44,37,32,0.18)',
  padding: 14,
  display: 'grid',
  gap: 10,
};

const dividerStyle: React.CSSProperties = { height: 1, background: 'rgba(44,37,32,0.12)' };
const labelStyle: React.CSSProperties = { fontSize: 11, color: colors.dim, fontWeight: 800 };
const inputStyle: React.CSSProperties = {
  border: `1px solid ${colors.ink2}`,
  borderRadius: 10,
  padding: '8px 10px',
  fontSize: 13,
  background: colors.bg,
  color: colors.ink,
};
const secondaryActionStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 7,
  border: `1px solid ${colors.ink2}`,
  borderRadius: radii.pill,
  background: 'transparent',
  color: colors.ink,
  padding: '8px 10px',
  cursor: 'pointer',
  fontWeight: 800,
  fontSize: 12,
};
