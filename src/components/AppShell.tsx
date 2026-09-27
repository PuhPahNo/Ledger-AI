import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Bell,
  Bot,
  Inbox as InboxIcon,
  LayoutDashboard,
  Lightbulb,
  Menu,
  Receipt,
  Search,
  Settings,
  Table as TableIcon,
  TrendingUp,
  Upload,
  Wallet,
} from 'lucide-react';
import type { Business, CategorizationReviewItem, CurrentUser } from '@/types/domain';
import type { AppView } from '@/types/navigation';
import { listCategorizationReviewItems } from '@/api';
import { inboxAttentionCount, useInbox } from '@/hooks/useInbox';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/cn';
import { CategorizationReviewCenter } from './CategorizationReviewCenter';
import { LogoMark } from './LogoMark';
import { ProfileFooter } from './shell/ProfileMenu';

interface NavItem {
  id: AppView;
  label: string;
  icon: typeof LayoutDashboard;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'inbox', label: 'Inbox', icon: InboxIcon },
  { id: 'transactions', label: 'Transactions', icon: TableIcon },
  { id: 'cash-flow', label: 'Cash Flow', icon: TrendingUp },
  { id: 'insights', label: 'Insights', icon: Lightbulb },
  { id: 'receipts', label: 'Receipts', icon: Receipt },
  { id: 'balances', label: 'Balances', icon: Wallet },
  { id: 'assistant', label: 'Assistant', icon: Bot },
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
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const { data: inbox } = useInbox();
  const inboxCount = inboxAttentionCount(inbox);
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

  const displayedReviewCount = usesExternalReviewCenter ? (reviewCount ?? 0) : internalReviewItems.length;
  // The bell routes to the Notifications page (the one place that shows everything waiting);
  // the modal remains only as a fallback for shells rendered without navigation.
  const openReviewCenter = onViewChange
    ? () => onViewChange('inbox')
    : onOpenReviewCenter ?? (() => setInternalReviewOpen(true));
  // When the bell leads to the Inbox it counts exactly what the Inbox lists (same shared
  // data, same counting rule); the fallback modal only shows review items, so it counts those.
  const bellCount = onViewChange ? inboxCount : displayedReviewCount;
  const navigate = onViewChange
    ? (view: AppView) => {
        setMobileNavOpen(false);
        onViewChange(view);
      }
    : undefined;

  return (
    <div className="min-h-screen bg-bg text-ink">
      <div className="mx-auto flex max-w-[1600px] gap-3 p-3 lg:p-4">
        <aside className="sticky top-3 hidden h-[calc(100vh-24px)] w-[220px] shrink-0 flex-col rounded-xl border border-ink2/10 bg-paper shadow-sm md:flex">
          <SidebarContent
            currentView={currentView}
            onViewChange={navigate}
            user={user}
            onLogout={onLogout}
            search={search}
            inboxCount={inboxCount}
          />
        </aside>
        <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
          <SheetContent side="left" className="w-[260px] gap-0 p-0" hideClose onOpenAutoFocus={(event) => event.preventDefault()}>
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <SidebarContent
              currentView={currentView}
              onViewChange={navigate}
              user={user}
              onLogout={onLogout}
              search={search}
              inboxCount={inboxCount}
            />
          </SheetContent>
        </Sheet>

        <main className="flex min-w-0 flex-1 flex-col gap-3">
          <ContextBar
            onOpenMobileNav={onViewChange ? () => setMobileNavOpen(true) : undefined}
            title={contextTitle}
            eyebrow={contextEyebrow}
            leading={contextLeading}
            actions={contextActions}
            reviewCount={bellCount}
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
  inboxCount: number;
}

/** Sidebar body — rendered in the desktop rail and in the mobile nav sheet. */
function SidebarContent({ currentView, onViewChange, user, onLogout, search, inboxCount }: SidebarProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
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
          const badgeCount = item.id === 'inbox' ? inboxCount : 0;
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
              {badgeCount > 0 && (
                <span
                  className={cn(
                    'ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none',
                    active ? 'bg-inverse-foreground text-inverse' : 'bg-coral text-on-coral',
                  )}
                >
                  {badgeCount > 9 ? '9+' : badgeCount}
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
    </div>
  );
}

interface ContextBarProps {
  onOpenMobileNav?: () => void;
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
  onOpenMobileNav,
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
        {onOpenMobileNav && (
          <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={onOpenMobileNav} title="Menu" aria-label="Open navigation">
            <Menu className="h-4 w-4" />
          </Button>
        )}
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
            <SelectTrigger className="h-9 w-36 rounded-full sm:w-44 border-transparent bg-cream/70 text-xs font-bold">
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

// Re-export for backwards compatibility / external usage.
export { CreditCard } from 'lucide-react';
