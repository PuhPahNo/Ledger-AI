import { useEffect, useState } from 'react';
import { getCurrentUser, logout, useMockApi } from './api';
import { AdminPage } from './components/admin/AdminPage';
import { LoginPage } from './components/auth/LoginPage';
import { Dashboard } from './components/Dashboard';
import type { CurrentUser } from './types/domain';

export default function App() {
  const [user, setUser] = useState<CurrentUser | null>(useMockApi ? {
    id: 'mock-admin',
    username: 'admin',
    displayName: 'Ledger Admin',
    role: 'admin',
    totpEnabled: false,
  } : null);
  const [checking, setChecking] = useState(!useMockApi);
  const [view, setView] = useState<'dashboard' | 'admin'>('dashboard');

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

  if (checking) return null;
  if (!user) return <LoginPage onLogin={setUser} />;
  if (view === 'admin') return <AdminPage user={user} onViewChange={setView} onLogout={handleLogout} />;
  return <Dashboard user={user} onViewChange={setView} onLogout={handleLogout} />;
}
