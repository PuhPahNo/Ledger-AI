// Hash routing: one pure mapping between `location.hash` and an AppRoute, including the
// redirects for every retired page name. Kept free of React so it can be unit-tested.

import type {
  AppRoute,
  AppView,
  NavTarget,
  ReportsTab,
  SettingsSection,
  TransactionsMode,
} from '@/types/navigation';

export const REPORT_TAB_IDS: readonly ReportsTab[] = ['overview', 'accounts', 'close'];
export const SETTINGS_SECTION_IDS: readonly SettingsSection[] = ['businesses', 'categories', 'receipts', 'security', 'data'];
const TRANSACTIONS_MODES: readonly TransactionsMode[] = ['transactions', 'receipts'];

export const HOME_ROUTE: AppRoute = { view: 'home' };

/** Retired page names → where that content lives now. */
const LEGACY_REDIRECTS: Record<string, AppRoute> = {
  dashboard: { view: 'home' },
  inbox: { view: 'home' },
  receipts: { view: 'transactions', mode: 'receipts' },
  'cash-flow': { view: 'reports', tab: 'overview' },
  insights: { view: 'reports', tab: 'overview' },
  balances: { view: 'reports', tab: 'accounts' },
  admin: { view: 'settings', section: 'businesses' },
};

/** Old admin tab ids (close-readiness `filters.tab`, bookmarks) → the merged settings section. */
const ADMIN_TAB_TO_SECTION: Record<string, SettingsSection> = {
  businesses: 'businesses',
  connections: 'businesses',
  categories: 'categories',
  rules: 'categories',
  tags: 'categories',
  receipts: 'receipts',
  users: 'security',
  security: 'security',
  exports: 'data',
  audit: 'data',
  data: 'data',
};

function defaultRoute(view: AppView): AppRoute {
  switch (view) {
    case 'transactions':
      return { view, mode: 'transactions' };
    case 'reports':
      return { view, tab: 'overview' };
    case 'settings':
      return { view, section: 'businesses' };
    default:
      return { view };
  }
}

function withSub(view: AppView, sub: string | undefined): AppRoute {
  const route = defaultRoute(view);
  if (!sub) return route;
  if (route.view === 'transactions' && (TRANSACTIONS_MODES as readonly string[]).includes(sub)) {
    return { view: 'transactions', mode: sub as TransactionsMode };
  }
  if (route.view === 'reports' && (REPORT_TAB_IDS as readonly string[]).includes(sub)) {
    return { view: 'reports', tab: sub as ReportsTab };
  }
  if (route.view === 'settings') {
    const section = ADMIN_TAB_TO_SECTION[sub];
    if (section) return { view: 'settings', section };
  }
  return route;
}

const VIEWS: readonly AppView[] = ['home', 'transactions', 'reports', 'assistant', 'settings'];

/**
 * Parse `#view[/sub]` (a leading slash is tolerated). Unknown hashes land on Home; retired
 * names redirect (`#inbox` → Home, `#receipts` → Transactions › Receipts, `#admin/exports`
 * → Settings › Data, …).
 */
export function parseHash(hash: string): AppRoute {
  const [head = '', sub] = hash.replace(/^#\/?/, '').split(/[/?]/);
  const name = head.trim().toLowerCase();
  if (!name) return HOME_ROUTE;
  if ((VIEWS as readonly string[]).includes(name)) return withSub(name as AppView, sub);
  if (name === 'admin' && sub) return withSub('settings', sub);
  return LEGACY_REDIRECTS[name] ?? HOME_ROUTE;
}

/** The canonical hash for a route (Home is the bare URL). Default sub-pages are omitted. */
export function routeToHash(route: AppRoute): string {
  switch (route.view) {
    case 'home':
      return '';
    case 'transactions':
      return route.mode === 'transactions' ? '#transactions' : `#transactions/${route.mode}`;
    case 'reports':
      return route.tab === 'overview' ? '#reports' : `#reports/${route.tab}`;
    case 'settings':
      return route.section === 'businesses' ? '#settings' : `#settings/${route.section}`;
    default:
      return `#${route.view}`;
  }
}

/** Resolve anything a component may pass to `onViewChange` into a concrete route. */
export function resolveNavTarget(target: NavTarget, filters?: Record<string, unknown> | null): AppRoute {
  if (typeof target !== 'string') return target;
  if (target === 'admin') {
    const tab = typeof filters?.tab === 'string' ? filters.tab : undefined;
    return withSub('settings', tab);
  }
  return parseHash(target);
}
