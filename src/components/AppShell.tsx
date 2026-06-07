import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Bell,
  ChevronsRight,
  CreditCard,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Moon,
  Receipt,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Table as TableIcon,
  TrendingUp,
  Upload,
  UserRound,
  Wallet,
} from 'lucide-react';
import type { Business, CategorizationReviewItem, CurrentUser } from '@/types/domain';
import type { AppView } from '@/types/navigation';
import { enableTotp, listCategorizationReviewItems, listReceipts, resetAdminUserPassword, setupTotp } from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/useToast';
import { useTheme } from '@/hooks/useTheme';
import { cn } from '@/lib/cn';
import { CategorizationReviewCenter } from './CategorizationReviewCenter';
import { LogoMark } from './LogoMark';

interface NavItem {
  id: AppView;
  label: string;
  icon: typeof LayoutDashboard;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'transactions', label: 'Transactions', icon: TableIcon },
  { id: 'cash-flow', label: 'Cash Flow', icon: TrendingUp },
  { id: 'insights', label: 'Insights', icon: Sparkles },
  { id: 'receipts', label: 'Receipts', icon: Receipt },
  { id: 'balances', label: 'Balances', icon: Wallet },
  { id: 'assistant', label: 'Assistant', icon: Sparkles },
];

interface AppShellProps {
  currentView: AppView;
  onViewChange?: (view: AppView) => void;
  onLogout?: () => void;
  user?: CurrentUser;
  onUploadReceipt?: (file: File) => void;
  /** Pretty title shown in the contextual bar above the page content. */
  contextTitle?: ReactNode;
  /** Crumb shown to the left of the title (e.g. "Workspace"). */
  contextEyebrow?: ReactNode;
  /** Optional left-aligned controls injected into the context bar (e.g. business switcher). */
  contextLeading?: ReactNode;
  /** Optional right-aligned controls injected into the context bar (between actions and bell). */
  contextActions?: ReactNode;
  /** Optional search input rendered inside the sidebar. */
  search?: { query: string; onQueryChange: (value: string) => void; placeholder?: string };
  /** Page body. */
  children: ReactNode;
  /** Show a notification dot count override (defaults to live review count). */
  reviewCount?: number;
  /** Override the default review-center open handler. */
  onOpenReviewCenter?: () => void;
  /** Optional business switcher rendered in the context bar. */
  businesses?: Business[];
  selectedBusiness?: string;
  onBusinessChange?: (business: string) => void;
}

export function AppShell({
  currentView,
  onViewChange,
  onLogout,
  user,
  onUploadReceipt,
  contextTitle,
  contextEyebrow,
  contextLeading,
  contextActions,
  search,
  children,
  reviewCount,
  onOpenReviewCenter,
  businesses,
  selectedBusiness,
  onBusinessChange,
}: AppShellProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [internalReviewOpen, setInternalReviewOpen] = useState(false);
  const [internalReviewItems, setInternalReviewItems] = useState<CategorizationReviewItem[]>([]);
  const [unmatchedReceiptCount, setUnmatchedReceiptCount] = useState(0);
  const usesExternalReviewCenter = Boolean(onOpenReviewCenter);

  const refreshInternalReviewItems = () => {
    if (usesExternalReviewCenter) return;
    listCategorizationReviewItems()
      .then(setInternalReviewItems)
      .catch(() => setInternalReviewItems([]));
  };

  useEffect(() => {
    let mounted = true;
    if (usesExternalReviewCenter) return;
    listCategorizationReviewItems()
      .then((items) => mounted && setInternalReviewItems(items))
      .catch(() => mounted && setInternalReviewItems([]));
    return () => {
      mounted = false;
    };
  }, [usesExternalReviewCenter]);

  useEffect(() => {
    let mounted = true;
    listReceipts({ status: 'pending' })
      .then((rows) => mounted && setUnmatchedReceiptCount(rows.length))
      .catch(() => mounted && setUnmatchedReceiptCount(0));
    return () => {
      mounted = false;
    };
  }, []);

  const displayedReviewCount = usesExternalReviewCenter ? (reviewCount ?? 0) : internalReviewItems.length;
  const openReviewCenter = onOpenReviewCenter ?? (() => setInternalReviewOpen(true));

  return (
    <div className="min-h-screen bg-bg text-ink">
      <div className="mx-auto flex max-w-[1600px] gap-3 p-3 lg:p-4">
        <Sidebar
          currentView={currentView}
          onViewChange={onViewChange}
          user={user}
          onLogout={onLogout}
          search={search}
          unmatchedReceiptCount={unmatchedReceiptCount}
        />

        <main className="flex min-w-0 flex-1 flex-col gap-3">
          <ContextBar
            title={contextTitle}
            eyebrow={contextEyebrow}
            leading={contextLeading}
            actions={contextActions}
            reviewCount={displayedReviewCount}
            onOpenReviewCenter={openReviewCenter}
            onClickUpload={onUploadReceipt ? () => fileInput.current?.click() : undefined}
            businesses={businesses}
            selectedBusiness={selectedBusiness}
            onBusinessChange={onBusinessChange}
          />

          <div className="min-w-0 flex-1">{children}</div>
        </main>
      </div>

      {onUploadReceipt && (
        <input
          ref={fileInput}
          type="file"
          accept="image/*,application/pdf,text/plain,text/html,.txt,.html,.htm"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onUploadReceipt(file);
            event.target.value = '';
          }}
        />
      )}

      {!usesExternalReviewCenter && (
        <CategorizationReviewCenter
          open={internalReviewOpen}
          items={internalReviewItems}
          businesses={businesses ?? []}
          onClose={() => setInternalReviewOpen(false)}
          onResolved={refreshInternalReviewItems}
        />
      )}
    </div>
  );
}

interface SidebarProps {
  currentView: AppView;
  onViewChange?: (view: AppView) => void;
  user?: CurrentUser;
  onLogout?: () => void;
  search?: { query: string; onQueryChange: (value: string) => void; placeholder?: string };
  unmatchedReceiptCount: number;
}

function Sidebar({ currentView, onViewChange, user, onLogout, search, unmatchedReceiptCount }: SidebarProps) {
  return (
    <aside className="sticky top-3 hidden h-[calc(100vh-24px)] w-[220px] shrink-0 flex-col rounded-xl border border-ink2/10 bg-paper shadow-sm md:flex">
      <div className="flex items-center gap-2.5 border-b border-ink2/10 px-4 py-3">
        <LogoMark className="h-9 w-9" />
        <div className="min-w-0">
          <div className="truncate font-display text-sm font-bold tracking-tight text-ink">Ledger AI</div>
          <div className="truncate font-mono text-[9px] uppercase tracking-wider text-dim">Multi-business</div>
        </div>
      </div>

      {search && (
        <div className="px-3 pt-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-dim" />
            <Input
              value={search.query}
              onChange={(event) => search.onQueryChange(event.target.value)}
              placeholder={search.placeholder ?? 'Search'}
              className="h-9 rounded-full border-transparent bg-cream/70 pl-9 text-xs focus-visible:bg-paper"
            />
          </div>
        </div>
      )}

      <nav className="mt-3 flex-1 overflow-y-auto px-2">
        <div className="px-2 pb-1 font-mono text-[10px] font-medium uppercase tracking-wider text-dim">Workspace</div>
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = currentView === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onViewChange?.(item.id)}
              className={cn(
                'group mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs font-bold transition-colors',
                active ? 'bg-inverse text-inverse-foreground' : 'text-ink hover:bg-cream',
              )}
            >
              <Icon className={cn('h-4 w-4', active ? 'text-inverse-foreground' : 'text-dim group-hover:text-ink')} />
              <span>{item.label}</span>
              {item.id === 'receipts' && unmatchedReceiptCount > 0 && (
                <span
                  className={cn(
                    'ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none',
                    active ? 'bg-inverse-foreground text-inverse' : 'bg-coral text-on-coral',
                  )}
                >
                  {unmatchedReceiptCount > 9 ? '9+' : unmatchedReceiptCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="border-t border-ink2/10 px-2 py-2">
        <button
          type="button"
          onClick={() => onViewChange?.('admin')}
          className={cn(
            'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs font-bold transition-colors',
            currentView === 'admin' ? 'bg-inverse text-inverse-foreground' : 'text-ink hover:bg-cream',
          )}
        >
          <Settings className={cn('h-4 w-4', currentView === 'admin' ? 'text-inverse-foreground' : 'text-dim')} />
          Admin & settings
        </button>
        <ProfileFooter user={user} onLogout={onLogout} />
      </div>
    </aside>
  );
}

function ProfileFooter({ user, onLogout }: { user?: CurrentUser; onLogout?: () => void }) {
  return (
    <ProfileMenu user={user} onLogout={onLogout}>
      <div className="mt-1 flex items-center gap-2.5 rounded-lg p-2 hover:bg-cream cursor-pointer">
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

interface ContextBarProps {
  title?: ReactNode;
  eyebrow?: ReactNode;
  leading?: ReactNode;
  actions?: ReactNode;
  reviewCount: number;
  onOpenReviewCenter: () => void;
  onClickUpload?: () => void;
  businesses?: Business[];
  selectedBusiness?: string;
  onBusinessChange?: (business: string) => void;
}

function ContextBar({
  title,
  eyebrow,
  leading,
  actions,
  reviewCount,
  onOpenReviewCenter,
  onClickUpload,
  businesses,
  selectedBusiness,
  onBusinessChange,
}: ContextBarProps) {
  const showBusinessSwitcher = businesses && businesses.length > 0 && onBusinessChange;
  return (
    <header className="flex flex-wrap items-center gap-3 rounded-xl border border-ink2/10 bg-paper px-3 py-2 shadow-sm">
      <div className="flex min-w-0 items-center gap-2">
        {eyebrow && (
          <>
            <span className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">{eyebrow}</span>
            <span className="text-dim">/</span>
          </>
        )}
        {title && <span className="truncate font-display text-sm font-bold text-ink">{title}</span>}
        {leading}
      </div>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        {showBusinessSwitcher && (
          <Select value={selectedBusiness ?? 'all'} onValueChange={(value) => onBusinessChange?.(value)}>
            <SelectTrigger className="h-9 w-44 rounded-full border-transparent bg-cream/70 text-xs font-bold">
              <SelectValue placeholder="Business" />
            </SelectTrigger>
            <SelectContent align="end" className="w-56">
              <SelectItem value="all">All businesses</SelectItem>
              {businesses!.map((business) => (
                <SelectItem key={business.id} value={business.id}>
                  {business.short} · {business.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {actions}
        <Button
          variant="secondary"
          size="icon-sm"
          onClick={onOpenReviewCenter}
          title="Notifications"
          className="relative"
        >
          <Bell className="h-4 w-4" />
          {reviewCount > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-coral px-1 text-[10px] font-bold leading-none text-on-coral">
              {reviewCount > 9 ? '9+' : reviewCount}
            </span>
          )}
        </Button>
        {onClickUpload && (
          <Button size="sm" onClick={onClickUpload} title="Upload receipt">
            <Upload className="h-4 w-4" />
            <span className="hidden xl:inline">Upload</span>
          </Button>
        )}
      </div>
    </header>
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

// Re-export for backwards compatibility / external usage.
export { CreditCard };
