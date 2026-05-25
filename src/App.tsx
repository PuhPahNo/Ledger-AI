import { useEffect, useState } from 'react';
import { getCurrentUser, logout, useMockApi } from './api';
import { AdminPage } from './components/admin/AdminPage';
import { AccountBalancesPage } from './components/AccountBalancesPage';
import { CashFlowPage } from './components/CashFlowPage';
import { LoginPage } from './components/auth/LoginPage';
import { Dashboard } from './components/Dashboard';
import { TransactionsPage } from './components/TransactionsPage';
import type { CurrentUser } from './types/domain';
import type { AppView, TransactionViewFilters } from './types/navigation';

export default function App() {
  const [user, setUser] = useState<CurrentUser | null>(useMockApi ? {
    id: 'mock-admin',
    username: 'admin',
    displayName: 'Ledger Admin',
    role: 'admin',
    totpEnabled: false,
  } : null);
  const [checking, setChecking] = useState(!useMockApi);
  const [view, setView] = useState<AppView>('dashboard');
  const [transactionFilters, setTransactionFilters] = useState<TransactionViewFilters | undefined>();

  useEffect(() => {
    if (useMockApi) return;
    getCurrentUser()
      .then((result) => setUser(result.user))
      .finally(() => setChecking(false));
  }, []);

  const handleLogout = async () => {
    await logout();
    setUser(null);
    setView('dashboard');
  };
  const openTransactions = (filters?: TransactionViewFilters) => {
    setTransactionFilters(filters);
    setView('transactions');
  };

  if (checking) return null;
  if (!user) return <LoginPage onLogin={setUser} />;
  if (view === 'admin') return <AdminPage user={user} onViewChange={setView} onLogout={handleLogout} />;
  if (view === 'balances') return <AccountBalancesPage user={user} onViewChange={setView} onLogout={handleLogout} />;
  if (view === 'cash-flow') return <CashFlowPage user={user} onViewChange={setView} onLogout={handleLogout} />;
  if (view === 'transactions') {
    return <TransactionsPage initialFilters={transactionFilters} user={user} onViewChange={setView} onLogout={handleLogout} />;
  }
  return <Dashboard user={user} onViewChange={setView} onOpenTransactions={openTransactions} onLogout={handleLogout} />;
}
