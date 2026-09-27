import { useEffect, useMemo, useState } from 'react';
import {
  getAdminOverview,
  listAccounts,
  listAuditLog,
  listConnections,
  type AdminOverview,
  type AuditLogRow,
} from '@/api';
import type { Account, Business, Connection, CurrentUser } from '@/types/domain';
import type { NavigateFn, SettingsSection } from '@/types/navigation';
import { useToast } from '@/hooks/useToast';
import { Skeleton } from '@/components/ui/skeleton';
import { AppShell } from '../AppShell';
import { ConnectionsManager } from '../ConnectionsManager';
import type { SaveAndRefresh } from '../admin/fields';
import { SETTINGS_SECTIONS, SubNav } from './settingsSections';

interface Props {
  user?: CurrentUser;
  onViewChange?: NavigateFn;
  onLogout?: () => void;
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
}

/** Settings (#settings/<section>) — the old eight admin tabs, grouped into four sections. */
export function SettingsPage({ user, onViewChange, onLogout, section, onSectionChange }: Props) {
  const { toast } = useToast();
  const [data, setData] = useState<AdminOverview | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [auditRows, setAuditRows] = useState<AuditLogRow[]>([]);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [query, setQuery] = useState('');

  const refresh = async () => {
    const [overview, connectionRows, accountRows, auditLog] = await Promise.all([
      getAdminOverview(),
      listConnections(),
      listAccounts(),
      listAuditLog(),
    ]);
    setData(overview);
    setConnections(connectionRows);
    setAccounts(accountRows);
    setAuditRows(auditLog);
  };

  useEffect(() => {
    refresh().catch((error: Error) => {
      toast({ variant: 'destructive', title: 'Failed to load settings', description: error.message });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const businesses = useMemo<Business[]>(
    () => (data?.businesses ?? []).map((business) => ({
      id: business.key,
      dbId: business.id,
      name: business.name,
      short: business.short,
      color: business.color,
      hue: business.hue,
      active: business.active,
    })),
    [data],
  );

  const saveAndRefresh: SaveAndRefresh = async (work, message) => {
    try {
      await work();
      await refresh();
      toast({ variant: 'success', title: message });
      return true;
    } catch (error) {
      toast({ variant: 'destructive', title: 'Save failed', description: error instanceof Error ? error.message : 'Try again.' });
      return false;
    }
  };

  const active = SETTINGS_SECTIONS.find((item) => item.id === section) ?? SETTINGS_SECTIONS[0];
  const Section = active.component;

  return (
    <AppShell
      currentView="settings"
      onViewChange={onViewChange}
      onLogout={onLogout}
      user={user}
      contextEyebrow="Settings"
      contextTitle={active.label}
      search={active.searchPlaceholder ? { query, onQueryChange: setQuery, placeholder: active.searchPlaceholder } : undefined}
    >
      <div className="flex flex-col gap-4">
        <SubNav items={SETTINGS_SECTIONS} active={active.id} onChange={onSectionChange} label="Settings sections" />
        <p className="text-sm text-dim">{active.description}</p>
        {!data ? (
          <div className="grid gap-4 lg:grid-cols-12" aria-hidden="true">
            <Skeleton className="h-64 lg:col-span-4" />
            <Skeleton className="h-64 lg:col-span-8" />
          </div>
        ) : (
          <Section
            data={data}
            businesses={businesses}
            connections={connections}
            accounts={accounts}
            auditRows={auditRows}
            query={query}
            user={user}
            saveAndRefresh={saveAndRefresh}
            openConnectionsManager={() => setConnectionsOpen(true)}
          />
        )}
      </div>

      <ConnectionsManager
        open={connectionsOpen}
        businesses={businesses}
        connections={connections}
        accounts={accounts}
        onClose={() => setConnectionsOpen(false)}
        onRefresh={() => refresh().catch((error: Error) => toast({ variant: 'destructive', title: 'Refresh failed', description: error.message }))}
      />
    </AppShell>
  );
}
