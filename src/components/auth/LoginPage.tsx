import { useState } from 'react';
import { login } from '@/api';
import type { CurrentUser } from '@/types/domain';
import { colors, fonts, radii } from '@/theme/tokens';

interface Props {
  onLogin: (user: CurrentUser) => void;
}

export function LoginPage({ onLogin }: Props) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await login(username, password, needsTotp ? totpCode : undefined);
      if (result.requiresTotp) {
        setNeedsTotp(true);
      } else if (result.user) {
        onLogin(result.user);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main
      style={{
        minHeight: '100vh',
        background: colors.bg,
        display: 'grid',
        placeItems: 'center',
        fontFamily: fonts.sans,
        color: colors.ink,
        padding: 24,
      }}
    >
      <form
        onSubmit={submit}
        style={{
          width: 'min(420px, 100%)',
          background: colors.paper,
          borderRadius: radii.tile,
          padding: 24,
          display: 'grid',
          gap: 14,
          boxShadow: '0 16px 50px rgba(21,20,15,0.08)',
        }}
      >
        <div style={{ fontFamily: fonts.display, fontSize: 26, fontWeight: 700 }}>Ledger AI</div>
        <label style={{ display: 'grid', gap: 6, fontSize: 13, fontWeight: 700 }}>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} style={inputStyle} />
        </label>
        <label style={{ display: 'grid', gap: 6, fontSize: 13, fontWeight: 700 }}>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={inputStyle} />
        </label>
        {needsTotp && (
          <label style={{ display: 'grid', gap: 6, fontSize: 13, fontWeight: 700 }}>
            Authenticator code
            <input value={totpCode} onChange={(e) => setTotpCode(e.target.value)} style={inputStyle} inputMode="numeric" />
          </label>
        )}
        {error && <div style={{ color: colors.coralInk, fontSize: 13 }}>{error}</div>}
        <button
          type="submit"
          disabled={busy}
          style={{
            border: 'none',
            borderRadius: radii.pill,
            background: colors.ink,
            color: colors.lemon,
            padding: '11px 14px',
            cursor: busy ? 'wait' : 'pointer',
            fontWeight: 800,
          }}
        >
          {busy ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}

const inputStyle: React.CSSProperties = {
  border: `1px solid ${colors.ink2}`,
  borderRadius: 10,
  padding: '10px 12px',
  font: 'inherit',
};
