import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Bell,
  Bot,
  Home as HomeIcon,
  LineChart,
  Menu,
  Search,
  Settings,
  Table as TableIcon,
  Upload,
} from 'lucide-react';
import type { Business, CurrentUser } from '@/types/domain';
import type { AppView, NavigateFn, NavTarget } from '@/types/navigation';
import { inboxAttentionCount, useInbox } from '@/hooks/useInbox';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/cn';
import { LogoMark } from './LogoMark';
import { ProfileFooter } from './shell/ProfileMenu';

interface NavItem {
  id: AppView;
  label: string;
  icon: typeof HomeIcon;
}

/** The sidebar. Settings lives in the footer; everything else is one of these four. */
const NAV_ITEMS: NavItem[] = [
  { id: 'home', label: 'Home', icon: HomeIcon },
  { id: 'transactions', label: 'Transactions', icon: TableIcon },
  { id: 'reports', label: 'Reports', icon: LineChart },
  { id: 'assistant', label: 'Assistant', icon: Bot },
];

/** Element id of Home's "Needs you" section — the bell scrolls to it. */
export const NEEDS_YOU_ANCHOR = 'needs-you';

interface AppShellProps {
  currentView: AppView;
  onViewChange?: NavigateFn;
  onLogout?: () => void;
  user?: CurrentUser;
  onUploadReceipt?: (file: File) => void;
  /** Pretty title shown in the contextual bar above the page content. */
  contextTitle?: ReactNode;
  /** Crumb shown to the left of the title (e.g. "Reports"). */
  contextEyebrow?: ReactNode;
  /** Optional right-aligned controls injected into the context bar (between actions and bell). */
  contextActions?: ReactNode;
  /** Optional search input rendered inside the sidebar. */
  search?: { query: string; onQueryChange: (value: string) => void; placeholder?: string };
  /** Page body. */
  children: ReactNode;
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
  contextActions,
  search,
  children,
  businesses,
  selectedBusiness,
  onBusinessChange,
}: AppShellProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const { data: inbox } = useInbox();
  const needsYouCount = inboxAttentionCount(inbox);

  const navigate = onViewChange
    ? (target: NavTarget) => {
        setMobileNavOpen(false);
        onViewChange(target);
      }
    : undefined;
  // The bell counts exactly what Home › Needs you lists (same shared data, same rule).
  const openNeedsYou = () => {
    onViewChange?.('home');
    window.setTimeout(() => document.getElementById(NEEDS_YOU_ANCHOR)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  };

  const sidebar = (
    <SidebarContent
      currentView={currentView}
      onViewChange={navigate}
      user={user}
      onLogout={onLogout}
      search={search}
      needsYouCount={needsYouCount}
    />
  );

  return (
    <div className="min-h-screen overflow-x-clip bg-bg text-ink">
      <div className="mx-auto flex max-w-[1600px] gap-3 p-2 sm:p-3 lg:p-4">
        <aside className="sticky top-3 hidden h-[calc(100vh-24px)] w-[208px] shrink-0 flex-col rounded-xl border border-ink2/10 bg-paper shadow-sm md:flex">
          {sidebar}
        </aside>
        <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
          <SheetContent side="left" className="w-[260px] gap-0 p-0" hideClose onOpenAutoFocus={(event) => event.preventDefault()}>
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            {sidebar}
          </SheetContent>
        </Sheet>

        <main className="flex min-w-0 flex-1 flex-col gap-3">
          <ContextBar
            onOpenMobileNav={onViewChange ? () => setMobileNavOpen(true) : undefined}
            title={contextTitle}
            eyebrow={contextEyebrow}
            actions={contextActions}
            needsYouCount={needsYouCount}
            onOpenNeedsYou={onViewChange ? openNeedsYou : undefined}
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
    </div>
  );
}

interface SidebarProps {
  currentView: AppView;
  onViewChange?: NavigateFn;
  user?: CurrentUser;
  onLogout?: () => void;
  search?: { query: string; onQueryChange: (value: string) => void; placeholder?: string };
  needsYouCount: number;
}

/** Sidebar body — rendered in the desktop rail and in the mobile nav sheet. */
function SidebarContent({ currentView, onViewChange, user, onLogout, search, needsYouCount }: SidebarProps) {
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
              aria-label={search.placeholder ?? 'Search'}
              className="h-10 rounded-full border-transparent bg-cream/70 pl-9 text-xs focus-visible:bg-paper md:h-9"
            />
          </div>
        </div>
      )}

      <nav className="mt-3 flex-1 overflow-y-auto px-2" aria-label="Main">
        {NAV_ITEMS.map((item) => (
          <NavButton
            key={item.id}
            item={item}
            active={currentView === item.id}
            badge={item.id === 'home' ? needsYouCount : 0}
            onClick={() => onViewChange?.(item.id)}
          />
        ))}
      </nav>

      <div className="border-t border-ink2/10 px-2 py-2">
        <NavButton
          item={{ id: 'settings', label: 'Settings', icon: Settings }}
          active={currentView === 'settings'}
          badge={0}
          onClick={() => onViewChange?.('settings')}
        />
        <ProfileFooter user={user} onLogout={onLogout} onOpenSecurity={() => onViewChange?.({ view: 'settings', section: 'security' })} />
      </div>
    </div>
  );
}

function NavButton({ item, active, badge, onClick }: { item: NavItem; active: boolean; badge: number; onClick: () => void }) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group mb-0.5 flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs font-bold transition-colors',
        active ? 'bg-inverse text-inverse-foreground' : 'text-ink hover:bg-cream',
      )}
    >
      <Icon className={cn('h-4 w-4', active ? 'text-inverse-foreground' : 'text-dim group-hover:text-ink')} />
      <span>{item.label}</span>
      {badge > 0 && (
        <span
          aria-label={`${badge} item${badge === 1 ? '' : 's'} need you`}
          className={cn(
            'ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none',
            active ? 'bg-inverse-foreground text-inverse' : 'bg-coral text-on-coral',
          )}
        >
          {badge > 9 ? '9+' : badge}
        </span>
      )}
    </button>
  );
}

interface ContextBarProps {
  onOpenMobileNav?: () => void;
  title?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  needsYouCount: number;
  onOpenNeedsYou?: () => void;
  onClickUpload?: () => void;
  businesses?: Business[];
  selectedBusiness?: string;
  onBusinessChange?: (business: string) => void;
}

function ContextBar({
  onOpenMobileNav,
  title,
  eyebrow,
  actions,
  needsYouCount,
  onOpenNeedsYou,
  onClickUpload,
  businesses,
  selectedBusiness,
  onBusinessChange,
}: ContextBarProps) {
  const showBusinessSwitcher = businesses && businesses.length > 0 && onBusinessChange;
  return (
    <header className="flex flex-wrap items-center gap-2 rounded-xl border border-ink2/10 bg-paper px-2 py-2 shadow-sm sm:gap-3 sm:px-3">
      <div className="flex min-w-0 items-center gap-2">
        {onOpenMobileNav && (
          <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={onOpenMobileNav} title="Menu" aria-label="Open navigation">
            <Menu className="h-4 w-4" />
          </Button>
        )}
        {eyebrow && (
          <>
            <span className="hidden font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim sm:inline">{eyebrow}</span>
            <span className="hidden text-dim sm:inline">/</span>
          </>
        )}
        {title && <span className="truncate font-display text-sm font-bold text-ink">{title}</span>}
      </div>

      <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
        {showBusinessSwitcher && (
          <Select value={selectedBusiness ?? 'all'} onValueChange={(value) => onBusinessChange?.(value)}>
            <SelectTrigger aria-label="Business" className="h-10 w-36 rounded-full border-transparent bg-cream/70 text-xs font-bold sm:h-9 sm:w-44">
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
        {onOpenNeedsYou && (
          <Button
            variant="secondary"
            size="icon-sm"
            onClick={onOpenNeedsYou}
            title="Needs you"
            aria-label={needsYouCount > 0 ? `${needsYouCount} items need you` : 'Nothing needs you'}
            className="relative"
          >
            <Bell className="h-4 w-4" />
            {needsYouCount > 0 && (
              <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-coral px-1 text-[10px] font-bold leading-none text-on-coral">
                {needsYouCount > 9 ? '9+' : needsYouCount}
              </span>
            )}
          </Button>
        )}
        {onClickUpload && (
          <Button size="sm" onClick={onClickUpload} title="Upload receipt" aria-label="Upload receipt">
            <Upload className="h-4 w-4" />
            <span className="hidden xl:inline">Upload</span>
          </Button>
        )}
      </div>
    </header>
  );
}
