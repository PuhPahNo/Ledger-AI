import { useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronsRight, LogOut, Moon, ShieldCheck, UserRound } from 'lucide-react';
import type { CurrentUser } from '@/types/domain';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { useTheme } from '@/hooks/useTheme';

interface ProfileProps {
  user?: CurrentUser;
  onLogout?: () => void;
  /** Opens Settings › Users & security (password and 2FA live there). */
  onOpenSecurity?: () => void;
}

export function ProfileFooter({ user, onLogout, onOpenSecurity }: ProfileProps) {
  return (
    <ProfileMenu user={user} onLogout={onLogout} onOpenSecurity={onOpenSecurity}>
      <div className="mt-1 flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg p-2 hover:bg-cream">
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

function ProfileMenu({ children, user, onLogout, onOpenSecurity }: ProfileProps & { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { theme, setTheme } = useTheme();

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
      <DropdownMenuContent align="end" className="w-64 p-4">
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

        <div className="flex min-h-10 items-center justify-between gap-3">
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

        {onOpenSecurity && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-1 w-full justify-start"
            onClick={() => {
              setOpen(false);
              onOpenSecurity();
            }}
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            Password & 2FA
          </Button>
        )}

        {onLogout && (
          <>
            <Separator className="my-3" />
            <Button variant="ghost" size="sm" onClick={onLogout} className="w-full justify-start text-coral-ink hover:bg-coral/10">
              <LogOut className="h-3.5 w-3.5" />
              Logout
            </Button>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
