import { useRef, useState } from 'react';
import { Bell, KeyRound, LogOut, Search, Settings, ShieldCheck, Upload, UserRound } from 'lucide-react';
import type { Business, CurrentUser } from '@/types/domain';
import type { AppView } from '@/types/navigation';
import { enableTotp, resetAdminUserPassword, setupTotp } from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useToast } from '@/hooks/useToast';
import { cn } from '@/lib/cn';

interface Props {
  onUploadReceipt: (file: File) => void;
  currentView?: AppView;
  onViewChange?: (view: AppView) => void;
  onLogout?: () => void;
  user?: CurrentUser;
  businesses?: Business[];
  selectedBusiness?: string;
  onBusinessChange?: (business: string) => void;
  query?: string;
  onQueryChange?: (query: string) => void;
  reviewCount?: number;
  onOpenReviewCenter?: () => void;
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
  reviewCount = 0,
  onOpenReviewCenter,
}: Props) {
  const fileInput = useRef<HTMLInputElement>(null);

  return (
    <header className="flex flex-wrap items-center gap-2 rounded-xl border border-ink2/8 bg-paper px-3 py-2 shadow-sm lg:flex-nowrap">
      <div className="flex shrink-0 items-center gap-2">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-ink font-display text-lg font-bold text-lemon">
          L
        </div>
        <div className="hidden font-display text-lg font-bold tracking-tight text-ink sm:block">Ledger AI</div>
        <span className="hidden rounded-full bg-cream px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider text-dim 2xl:inline-flex">
          internal v1
        </span>
      </div>

      <ToggleGroup
        type="single"
        value={currentView}
        onValueChange={(value) => value && onViewChange?.(value as AppView)}
        className="min-w-0 shrink overflow-x-auto"
      >
        <ToggleGroupItem value="dashboard">Dashboard</ToggleGroupItem>
        <ToggleGroupItem value="transactions">Transactions</ToggleGroupItem>
        <ToggleGroupItem value="cash-flow">Cash Flow</ToggleGroupItem>
        <ToggleGroupItem value="balances">Balances</ToggleGroupItem>
        <ToggleGroupItem value="insights">Insights</ToggleGroupItem>
        <ToggleGroupItem value="assistant">Assistant</ToggleGroupItem>
      </ToggleGroup>

      {currentView === 'dashboard' && businesses.length > 0 && onBusinessChange && (
        <Select value={selectedBusiness} onValueChange={onBusinessChange}>
          <SelectTrigger className="h-9 w-36 shrink-0 rounded-full border-transparent bg-cream/70 text-xs font-bold 2xl:w-40">
            <SelectValue placeholder="Business" />
          </SelectTrigger>
          <SelectContent align="end" className="w-56">
            <SelectItem value="all">All businesses</SelectItem>
            {businesses.map((business) => (
              <SelectItem key={business.id} value={business.id}>
                {business.short} · {business.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      <div className="relative order-last w-full min-w-0 sm:order-none sm:ml-auto sm:w-64 sm:max-w-xs lg:flex-none 2xl:w-72">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-dim" />
        <Input
          value={query}
          onChange={(event) => onQueryChange?.(event.target.value)}
          placeholder="Search merchants, categories, notes"
          className="h-9 rounded-full pl-9 bg-cream/70 border-transparent focus-visible:bg-paper"
        />
      </div>

      {onOpenReviewCenter && (
        <Button
          variant="secondary"
          size="icon-sm"
          onClick={onOpenReviewCenter}
          title="Notifications"
          className="relative"
        >
          <Bell className="h-4 w-4" />
          {reviewCount > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-coral px-1 text-[10px] font-bold leading-none text-coral-ink">
              {reviewCount > 9 ? '9+' : reviewCount}
            </span>
          )}
        </Button>
      )}

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
      <Button size="sm" onClick={() => fileInput.current?.click()} title="Upload receipt">
        <Upload className="h-4 w-4" />
        <span className="hidden 2xl:inline">Upload</span>
      </Button>

      <ProfileMenu user={user} onLogout={onLogout} onViewChange={onViewChange} />
    </header>
  );
}

function ProfileMenu({
  user,
  onLogout,
  onViewChange,
}: {
  user?: CurrentUser;
  onLogout?: () => void;
  onViewChange?: (view: AppView) => void;
}) {
  const [open, setOpen] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [totp, setTotp] = useState<{ qrDataUrl: string; code: string } | null>(null);
  const { toast } = useToast();
  const initial = (user?.displayName || user?.username || 'A').slice(0, 1).toUpperCase();

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
          className={cn(
            'flex h-9 w-9 items-center justify-center rounded-full bg-coral font-bold text-paper transition-shadow',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2',
          )}
          title="Profile settings"
        >
          {initial}
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

        {onViewChange && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                onViewChange('admin');
                setOpen(false);
              }}
              className="w-full justify-start"
            >
              <Settings className="h-3.5 w-3.5" />
              Admin settings
            </Button>

            <Separator className="my-3" />
          </>
        )}

        <div className="grid gap-2">
          <label className="grid gap-1.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-dim">Reset password</span>
            <Input
              type="password"
              value={newPassword}
              placeholder="12+ character password"
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
