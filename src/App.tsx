import { useEffect, useState } from 'react';
import { getCurrentUser, logout, useMockApi } from './api';
import { LoginPage } from './components/auth/LoginPage';
import { EmployeeReceiptUploadPage } from './components/receipt-upload/EmployeeReceiptUploadPage';
import { HomePage } from './components/home/HomePage';
import { TransactionsPage } from './components/TransactionsPage';
import { ReportsPage } from './components/reports/ReportsPage';
import { AssistantPage } from './components/AssistantPage';
import { SettingsPage } from './components/settings/SettingsPage';
import { clearHomeCache } from './hooks/useHome';
import { clearInboxCache } from './hooks/useInbox';
import { clearConversation } from './components/assistant/conversationStorage';
import { parseHash, resolveNavTarget, routeToHash } from './lib/routes';
import { LEDGER_DATA_CHANGED_EVENT } from './types/assistant';
import type { CurrentUser } from './types/domain';
import type { AppRoute, NavTarget, TransactionViewFilters } from './types/navigation';

function routeFromLocation(): AppRoute {
  if (typeof window === 'undefined') return { view: 'home' };
  return parseHash(window.location.hash);
}

function writeRouteHash(route: AppRoute, mode: 'push' | 'replace' = 'push') {
  if (typeof window === 'undefined') return;
  const nextHash = routeToHash(route);
  if (window.location.hash === nextHash || (!window.location.hash && !nextHash)) return;
  const url = nextHash || window.location.pathname + window.location.search;
  if (mode === 'replace') window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
}

function isReceiptUploadPortal(): boolean {
  if (typeof window === 'undefined') return false;
  return window.location.pathname === '/upload' || window.location.pathname === '/receipt-upload';
}

export default function App() {
  const [user, setUser] = useState<CurrentUser | null>(useMockApi ? {
    id: 'mock-admin',
    username: 'admin',
    displayName: 'Ledger Admin',
    role: 'admin',
    totpEnabled: false,
  } : null);
  const [checking, setChecking] = useState(!useMockApi);
  const [route, setRouteState] = useState<AppRoute>(() => routeFromLocation());
  const [transactionFilters, setTransactionFilters] = useState<TransactionViewFilters | undefined>();

  const navigate = (target: NavTarget, filters?: Record<string, unknown> | null) => {
    const next = resolveNavTarget(target, filters);
    // Deep-link filters belong to one trip into Transactions; leaving drops them.
    if (next.view !== 'transactions') setTransactionFilters(undefined);
    setRouteState(next);
    writeRouteHash(next);
    window.scrollTo?.({ top: 0 });
  };

  useEffect(() => {
    if (useMockApi || isReceiptUploadPortal()) return;
    getCurrentUser()
      .then((result) => setUser(result.user))
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    // Old bookmarks and links (#inbox, #cash-flow, #admin…) are rewritten to their new address.
    const syncRoute = () => {
      const next = routeFromLocation();
      writeRouteHash(next, 'replace');
      setRouteState(next);
    };
    syncRoute();
    window.addEventListener('hashchange', syncRoute);
    window.addEventListener('popstate', syncRoute);
    return () => {
      window.removeEventListener('hashchange', syncRoute);
      window.removeEventListener('popstate', syncRoute);
    };
  }, []);

  // Assistant-applied changes (recategorize, pair receipts, new rules) make cached page
  // data stale; drop the caches so the next page visit refetches.
  useEffect(() => {
    const invalidate = () => {
      clearHomeCache();
      clearInboxCache();
    };
    window.addEventListener(LEDGER_DATA_CHANGED_EVENT, invalidate);
    return () => window.removeEventListener(LEDGER_DATA_CHANGED_EVENT, invalidate);
  }, []);

  const handleLogout = async () => {
    await logout();
    clearHomeCache();
    clearInboxCache();
    // The saved assistant chat holds financial answers; don't leave it for the next login.
    clearConversation();
    setUser(null);
    navigate('home');
  };
  const openTransactions = (filters?: TransactionViewFilters) => {
    setTransactionFilters(filters);
    navigate({ view: 'transactions', mode: 'transactions' });
  };

  if (isReceiptUploadPortal()) return <EmployeeReceiptUploadPage />;
  if (checking) return null;
  if (!user) return <LoginPage onLogin={setUser} />;

  const shared = { user, onViewChange: navigate, onLogout: handleLogout };
  switch (route.view) {
    case 'transactions':
      return (
        <TransactionsPage
          {...shared}
          mode={route.mode}
          initialFilters={transactionFilters}
          onModeChange={(mode) => navigate({ view: 'transactions', mode })}
        />
      );
    case 'reports':
      return (
        <ReportsPage
          {...shared}
          tab={route.tab}
          onTabChange={(tab) => navigate({ view: 'reports', tab })}
          onOpenTransactions={openTransactions}
        />
      );
    case 'assistant':
      return <AssistantPage {...shared} />;
    case 'settings':
      return (
        <SettingsPage
          {...shared}
          section={route.section}
          onSectionChange={(section) => navigate({ view: 'settings', section })}
        />
      );
    default:
      return <HomePage {...shared} onOpenTransactions={openTransactions} />;
  }
}
