import { useEffect, useState } from 'react';
import { getCurrentUser, logout, useMockApi } from './api';
import { AdminPage } from './components/admin/AdminPage';
import { AccountBalancesPage } from './components/AccountBalancesPage';
import { CashFlowPage } from './components/CashFlowPage';
import { LoginPage } from './components/auth/LoginPage';
import { Dashboard } from './components/Dashboard';
import { EmployeeReceiptUploadPage } from './components/receipt-upload/EmployeeReceiptUploadPage';
import { OwnerInsightsPage } from './components/OwnerInsightsPage';
import { AssistantPage } from './components/AssistantPage';
import { ReceiptsPage } from './components/ReceiptsPage';
import { RulesPage } from './components/RulesPage';
import { TransactionsPage } from './components/TransactionsPage';
import { clearDashboardCache } from './hooks/useDashboard';
import type { CurrentUser } from './types/domain';
import type { AppView, TransactionViewFilters } from './types/navigation';

const views = new Set<AppView>(['dashboard', 'transactions', 'receipts', 'rules', 'cash-flow', 'balances', 'insights', 'assistant', 'admin']);

function viewFromHash(): AppView {
  if (typeof window === 'undefined') return 'dashboard';
  const value = window.location.hash.replace(/^#\/?/, '') as AppView;
  return views.has(value) ? value : 'dashboard';
}

function writeViewHash(view: AppView) {
  if (typeof window === 'undefined') return;
  const nextHash = view === 'dashboard' ? '' : `#${view}`;
  const currentHash = window.location.hash;
  if (currentHash === nextHash || (!currentHash && !nextHash)) return;

  if (nextHash) {
    window.history.pushState(null, '', nextHash);
  } else {
    window.history.pushState(null, '', window.location.pathname + window.location.search);
  }
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
  const [view, setViewState] = useState<AppView>(() => viewFromHash());
  const [transactionFilters, setTransactionFilters] = useState<TransactionViewFilters | undefined>();

  const setView = (nextView: AppView) => {
    setViewState(nextView);
    writeViewHash(nextView);
  };

  useEffect(() => {
    if (useMockApi || isReceiptUploadPortal()) return;
    getCurrentUser()
      .then((result) => setUser(result.user))
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    const syncView = () => setViewState(viewFromHash());
    window.addEventListener('hashchange', syncView);
    return () => window.removeEventListener('hashchange', syncView);
  }, []);

  const handleLogout = async () => {
    await logout();
    clearDashboardCache();
    setUser(null);
    setView('dashboard');
  };
  const openTransactions = (filters?: TransactionViewFilters) => {
    setTransactionFilters(filters);
    setView('transactions');
  };

  if (isReceiptUploadPortal()) return <EmployeeReceiptUploadPage />;
  if (checking) return null;
  if (!user) return <LoginPage onLogin={setUser} />;
  if (view === 'admin') return <AdminPage user={user} onViewChange={setView} onLogout={handleLogout} />;
  if (view === 'balances') return <AccountBalancesPage user={user} onViewChange={setView} onLogout={handleLogout} />;
  if (view === 'cash-flow') return <CashFlowPage user={user} onViewChange={setView} onLogout={handleLogout} />;
  if (view === 'insights') return <OwnerInsightsPage user={user} onViewChange={setView} onOpenTransactions={openTransactions} onLogout={handleLogout} />;
  if (view === 'assistant') return <AssistantPage user={user} onViewChange={setView} onLogout={handleLogout} />;
  if (view === 'receipts') return <ReceiptsPage user={user} onViewChange={setView} onLogout={handleLogout} />;
  if (view === 'rules') return <RulesPage user={user} onViewChange={setView} onLogout={handleLogout} />;
  if (view === 'transactions') {
    return <TransactionsPage initialFilters={transactionFilters} user={user} onViewChange={setView} onLogout={handleLogout} />;
  }
  return <Dashboard user={user} onViewChange={setView} onOpenTransactions={openTransactions} onLogout={handleLogout} />;
}
