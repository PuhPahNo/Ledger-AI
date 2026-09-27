import { useState } from 'react';
import { KeyRound, ShieldCheck } from 'lucide-react';
import type { CurrentUser } from '@/types/domain';
import { enableTotp, resetAdminUserPassword, setupTotp } from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/useToast';

/**
 * The signed-in user's own password + authenticator (2FA) controls. Lives in
 * Settings › Users & security (it used to be squeezed into the profile dropdown).
 */
export function AccountSecurityPanel({ user }: { user?: CurrentUser }) {
  const [newPassword, setNewPassword] = useState('');
  const [totp, setTotp] = useState<{ qrDataUrl: string; code: string } | null>(null);
  const [currentTotpCode, setCurrentTotpCode] = useState('');
  const { toast } = useToast();

  const resetPassword = async () => {
    if (!user) return;
    if (newPassword.length < 12) {
      toast({ variant: 'destructive', title: 'Password too short', description: 'Use at least 12 characters.' });
      return;
    }
    try {
      await resetAdminUserPassword(user.id, newPassword);
      setNewPassword('');
      toast({ variant: 'success', title: 'Password updated', description: 'Use it the next time you log in.' });
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Password update failed',
        description: error instanceof Error ? error.message : 'Try again.',
      });
    }
  };

  const startTotp = async () => {
    try {
      const result = await setupTotp(user?.totpEnabled ? currentTotpCode : undefined);
      setCurrentTotpCode('');
      setTotp({ qrDataUrl: result.qrDataUrl, code: '' });
    } catch (error) {
      toast({
        variant: 'destructive',
        title: '2FA setup failed',
        description: error instanceof Error ? error.message : 'Try again.',
      });
    }
  };

  const confirmTotp = async () => {
    if (!totp?.code) return;
    try {
      await enableTotp(totp.code);
      toast({ variant: 'success', title: 'Two-factor enabled' });
      setTotp(null);
    } catch (error) {
      toast({
        variant: 'destructive',
        title: '2FA setup failed',
        description: error instanceof Error ? error.message : 'Try again.',
      });
    }
  };

  return (
    <div className="grid gap-5 md:grid-cols-2">
      <div className="grid content-start gap-2">
        <label className="grid gap-1.5">
          <span className="text-[10px] font-bold uppercase tracking-wider text-dim">New password</span>
          <Input
            name="profile-new-password"
            type="password"
            value={newPassword}
            placeholder="12+ characters"
            autoComplete="new-password"
            onChange={(event) => setNewPassword(event.target.value)}
          />
        </label>
        <Button variant="outline" size="sm" className="justify-self-start" onClick={resetPassword}>
          <KeyRound className="h-3.5 w-3.5" />
          Update password
        </Button>
      </div>

      <div className="grid content-start gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-dim">
          Authenticator (2FA) · {user?.totpEnabled ? 'on' : 'off'}
        </span>
        {!totp ? (
          <>
            {user?.totpEnabled && (
              <Input
                name="profile-current-totp"
                value={currentTotpCode}
                onChange={(event) => setCurrentTotpCode(event.target.value)}
                placeholder="Current authenticator code"
                inputMode="numeric"
                autoComplete="one-time-code"
              />
            )}
            <Button
              variant="outline"
              size="sm"
              className="justify-self-start"
              onClick={startTotp}
              disabled={Boolean(user?.totpEnabled) && currentTotpCode.trim().length < 6}
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              {user?.totpEnabled ? 'Replace authenticator' : 'Set up 2FA'}
            </Button>
          </>
        ) : (
          <>
            {totp.qrDataUrl && (
              <img
                src={totp.qrDataUrl}
                alt="Authenticator QR code"
                className="h-32 w-32 rounded-md border border-ink2/10"
              />
            )}
            <Input
              value={totp.code}
              onChange={(event) => setTotp({ ...totp, code: event.target.value })}
              placeholder="Code from your authenticator"
              inputMode="numeric"
              autoComplete="one-time-code"
            />
            <Button size="sm" className="justify-self-start" onClick={confirmTotp}>
              Enable 2FA
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
