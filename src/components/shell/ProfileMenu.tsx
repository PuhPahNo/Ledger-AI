import { useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronsRight, KeyRound, LogOut, Moon, ShieldCheck, UserRound } from 'lucide-react';
import type { CurrentUser } from '@/types/domain';
import { enableTotp, resetAdminUserPassword, setupTotp } from '@/api';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/useToast';
import { useTheme } from '@/hooks/useTheme';

export function ProfileFooter({ user, onLogout }: { user?: CurrentUser; onLogout?: () => void }) {
  return (
    <ProfileMenu user={user} onLogout={onLogout}>
      <div className="mt-1 flex cursor-pointer items-center gap-2.5 rounded-lg p-2 hover:bg-cream">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-cream text-dim ring-1 ring-ink2/10">
          <UserRound className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1 text-left">
          <div className="truncate text-xs font-bold text-ink">{user?.displayName ?? 'Admin'}</div>
          <div className="truncate text-[10px] text-dim">{user?.username}</div>
        </div>
        <ChevronsRight className="h-3.5 w-3.5 text-dim" />
      </div>
    </ProfileMenu>
  );
}

function ProfileMenu({
  children,
  user,
  onLogout,
}: {
  children: ReactNode;
  user?: CurrentUser;
  onLogout?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [totp, setTotp] = useState<{ qrDataUrl: string; code: string } | null>(null);
  const { toast } = useToast();
  const { theme, setTheme } = useTheme();

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
    const result = await setupTotp();
    setTotp({ qrDataUrl: result.qrDataUrl, code: '' });
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
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2"
        >
          {children}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72 p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-cream">
            <UserRound className="h-4 w-4 text-ink" />
          </div>
          <div className="min-w-0">
            <div className="truncate font-bold text-ink">{user?.displayName ?? 'Admin'}</div>
            <div className="truncate text-xs text-dim">{user?.username}</div>
          </div>
        </div>

        <Separator className="my-3" />

        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Moon className="h-4 w-4 text-dim" />
            <span className="text-sm font-bold text-ink">Dark mode</span>
          </div>
          <Switch
            checked={theme === 'dark'}
            onCheckedChange={(checked) => setTheme(checked ? 'dark' : 'light')}
            aria-label="Toggle dark mode"
          />
        </div>

        <Separator className="my-3" />

        <div className="grid gap-2">
          <label className="grid gap-1.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-dim">Reset password</span>
            <Input
              name="profile-new-password"
              type="password"
              value={newPassword}
              placeholder="12+ character password"
              autoComplete="new-password"
              onChange={(event) => setNewPassword(event.target.value)}
              className="h-9"
            />
          </label>
          <Button variant="outline" size="sm" onClick={resetPassword}>
            <KeyRound className="h-3.5 w-3.5" />
            Update password
          </Button>
        </div>

        <Separator className="my-3" />

        {!totp ? (
          <Button variant="outline" size="sm" onClick={startTotp}>
            <ShieldCheck className="h-3.5 w-3.5" />
            Set up 2FA
          </Button>
        ) : (
          <div className="grid gap-2">
            {totp.qrDataUrl && (
              <img
                src={totp.qrDataUrl}
                alt="TOTP QR code"
                className="mx-auto h-32 w-32 rounded-md border border-ink2/10"
              />
            )}
            <Input
              value={totp.code}
              onChange={(event) => setTotp({ ...totp, code: event.target.value })}
              placeholder="Authenticator code"
              className="h-9"
            />
            <Button size="sm" onClick={confirmTotp}>
              Enable 2FA
            </Button>
          </div>
        )}

        {onLogout && (
          <>
            <Separator className="my-3" />
            <Button variant="ghost" size="sm" onClick={onLogout} className="text-coral-ink hover:bg-coral/10">
              <LogOut className="h-3.5 w-3.5" />
              Logout
            </Button>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
