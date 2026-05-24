import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { login } from '@/api';
import type { CurrentUser } from '@/types/domain';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';

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

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
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
    <main className="grid min-h-screen place-items-center bg-bg p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-ink font-display text-xl font-bold text-lemon">
            L
          </div>
          <div>
            <div className="font-display text-2xl font-bold tracking-tight">Ledger AI</div>
            <div className="text-xs text-dim">Sign in to continue</div>
          </div>
        </div>

        <form
          onSubmit={submit}
          className="grid gap-4 rounded-xl border border-ink2/10 bg-paper p-6 shadow-md"
        >
          <div className="grid gap-1.5">
            <Label htmlFor="login-username">Username</Label>
            <Input
              id="login-username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="login-password">Password</Label>
            <Input
              id="login-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          {needsTotp && (
            <div className="grid gap-1.5">
              <Label htmlFor="login-totp">Authenticator code</Label>
              <Input
                id="login-totp"
                value={totpCode}
                onChange={(event) => setTotpCode(event.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123 456"
                required
              />
            </div>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" disabled={busy} className="mt-2">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {busy ? 'Signing in…' : needsTotp ? 'Verify code' : 'Sign in'}
          </Button>
        </form>
      </div>
    </main>
  );
}
