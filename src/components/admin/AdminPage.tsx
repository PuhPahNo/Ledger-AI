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
import type { AppView } from '@/types/navigation';
import { useToast } from '@/hooks/useToast';
import { SectionHeader } from '@/components/ui/section-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AppShell } from '../AppShell';
import { ConnectionsManager } from '../ConnectionsManager';
import { AuditTab } from './tabs/AuditTab';
import { BusinessesTab } from './tabs/BusinessesTab';
import { CategoriesTab } from './tabs/CategoriesTab';
import { ConnectionsTab } from './tabs/ConnectionsTab';
import { ExportsTab } from './tabs/ExportsTab';
import { RulesTab } from './tabs/RulesTab';
import { TagsTab } from './tabs/TagsTab';
import { UsersTab } from './tabs/UsersTab';
import type { SaveAndRefresh } from './fields';

interface Props {
  onViewChange?: (view: AppView) => void;
  onLogout?: () => void;
  user?: CurrentUser;
}

type Tab = 'businesses' | 'users' | 'categories' | 'rules' | 'tags' | 'connections' | 'exports' | 'audit';

const tabs: Array<{ id: Tab; label: string }> = [
  { id: 'businesses', label: 'Businesses' },
  { id: 'users', label: 'Users' },
  { id: 'categories', label: 'Categories' },
  { id: 'rules', label: 'Rules' },
  { id: 'tags', label: 'Tags' },
  { id: 'connections', label: 'Connections' },
  { id: 'exports', label: 'Exports' },
  { id: 'audit', label: 'Audit' },
];

export function AdminPage({ onViewChange, onLogout, user }: Props) {
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>('businesses');
  const [data, setData] = useState<AdminOverview | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [auditRows, setAuditRows] = useState<AuditLogRow[]>([]);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);

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
    setLoading(false);
  };

  useEffect(() => {
    refresh().catch((error: Error) => {
      setLoading(false);
      toast({ variant: 'destructive', title: 'Failed to load admin data', description: error.message });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const businesses = useMemo<Business[]>(
    () =>
      (data?.businesses ?? []).map((business) => ({
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
      toast({
        variant: 'destructive',
        title: 'Save failed',
        description: error instanceof Error ? error.message : 'Try again.',
      });
      return false;
    }
  };

  const filteredAudit = auditRows.filter(
    (row) => !query || `${row.action} ${row.entityType} ${row.entityId ?? ''}`.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <AppShell
      currentView="admin"
      onViewChange={onViewChange}
      onLogout={onLogout}
      user={user}
      contextEyebrow="Workspace"
      contextTitle="Admin"
      search={{ query, onQueryChange: setQuery, placeholder: 'Search admin…' }}
    >
      <div className="flex flex-col gap-5">
        <SectionHeader
          eyebrow="Workspace"
          title="Admin settings"
          description="Manage businesses, users, categorization, connections, exports, and audit history."
        />

        <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
          <TabsList className="self-start">
            {tabs.map((item) => (
              <TabsTrigger key={item.id} value={item.id}>
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>

          {loading && (
            <div className="mt-4 grid gap-4 lg:grid-cols-12">
              <Skeleton className="h-64 lg:col-span-4" />
              <Skeleton className="h-64 lg:col-span-8" />
            </div>
          )}

          {!loading && data && (
            <>
              <TabsContent value="businesses">
                <BusinessesTab data={data} saveAndRefresh={saveAndRefresh} />
              </TabsContent>
              <TabsContent value="users">
                <UsersTab data={data} businesses={businesses} user={user} saveAndRefresh={saveAndRefresh} />
              </TabsContent>
              <TabsContent value="categories">
                <CategoriesTab data={data} businesses={businesses} saveAndRefresh={saveAndRefresh} />
              </TabsContent>
              <TabsContent value="rules">
                <RulesTab data={data} businesses={businesses} saveAndRefresh={saveAndRefresh} />
              </TabsContent>
              <TabsContent value="tags">
                <TagsTab />
              </TabsContent>
              <TabsContent value="connections">
                <ConnectionsTab connections={connections} onOpenConnections={() => setConnectionsOpen(true)} />
              </TabsContent>
              <TabsContent value="exports">
                <ExportsTab data={data} saveAndRefresh={saveAndRefresh} />
              </TabsContent>
              <TabsContent value="audit">
                <AuditTab rows={filteredAudit} query={query} />
              </TabsContent>
            </>
          )}
        </Tabs>
      </div>

      <ConnectionsManager
        open={connectionsOpen}
        businesses={businesses}
        connections={connections}
        accounts={accounts}
        onClose={() => setConnectionsOpen(false)}
        onRefresh={() =>
          refresh().catch((error: Error) => toast({ variant: 'destructive', title: 'Refresh failed', description: error.message }))
        }
      />
    </AppShell>
  );
}
