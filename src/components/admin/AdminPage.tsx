import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Save, UserPlus } from 'lucide-react';
import {
  createAdminUser,
  createBusiness,
  createCategory,
  createCategoryRule,
  createExport,
  getAdminOverview,
  listAccounts,
  listAuditLog,
  listConnections,
  resetAdminUserPassword,
  setAdminUserActive,
  updateAdminUser,
  updateBusiness,
  updateCategory,
  updateCategoryRule,
  type AdminOverview,
  type AuditLogRow,
} from '@/api';
import type { Account, Business, Connection, CurrentUser } from '@/types/domain';
import { useToast } from '@/hooks/useToast';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { SectionHeader } from '@/components/ui/section-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { HeaderBar } from '../HeaderBar';
import { ConnectionsManager } from '../ConnectionsManager';

interface Props {
  onViewChange?: (view: 'dashboard' | 'admin') => void;
  onLogout?: () => void;
  user?: CurrentUser;
}

type Tab = 'businesses' | 'users' | 'categories' | 'connections' | 'exports' | 'audit';
const tabs: Array<{ id: Tab; label: string }> = [
  { id: 'businesses', label: 'Businesses' },
  { id: 'users', label: 'Users' },
  { id: 'categories', label: 'Categories / Rules' },
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
  const [userForm, setUserForm] = useState({ username: '', displayName: '', password: '' });
  const [businessForm, setBusinessForm] = useState({ key: '', name: '', short: '', color: '#D97757', hue: 24 });
  const [categoryForm, setCategoryForm] = useState({ name: '', taxCode: '', color: '#D97757', businessId: '' });
  const [ruleForm, setRuleForm] = useState({
    categoryId: '',
    businessId: '',
    matchKind: 'merchant_contains',
    pattern: '',
    priority: 100,
  });

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

  const saveAndRefresh = async (work: () => Promise<unknown>, message: string): Promise<boolean> => {
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
    <div className="min-h-screen bg-bg text-ink">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-5 p-4">
        <HeaderBar
          onUploadReceipt={() => undefined}
          currentView="admin"
          onViewChange={onViewChange}
          onLogout={onLogout}
          user={user}
          query={query}
          onQueryChange={setQuery}
        />

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
                <div className="grid gap-4 lg:grid-cols-12">
                  <Card className="lg:col-span-4">
                    <CardHeader>
                      <CardTitle>Create business</CardTitle>
                      <CardDescription>Each business gets its own ledger, color, and short code.</CardDescription>
                    </CardHeader>
                    <CardContent className="grid gap-3">
                      <FieldText label="Name" value={businessForm.name} onChange={(name) => setBusinessForm({ ...businessForm, name })} />
                      <FieldText label="Short code" value={businessForm.short} onChange={(short) => setBusinessForm({ ...businessForm, short })} />
                      <FieldText label="URL key" value={businessForm.key} onChange={(key) => setBusinessForm({ ...businessForm, key })} placeholder="auto from name" />
                      <FieldColor label="Brand color" value={businessForm.color} onChange={(color) => setBusinessForm({ ...businessForm, color })} />
                      <Button
                        onClick={() =>
                          saveAndRefresh(
                            () => createBusiness({ ...businessForm, key: businessForm.key || undefined }),
                            'Business created.',
                          )
                        }
                      >
                        <Save className="h-3.5 w-3.5" /> Create business
                      </Button>
                    </CardContent>
                  </Card>

                  <Card className="lg:col-span-8">
                    <CardHeader>
                      <CardTitle>Business directory</CardTitle>
                      <CardDescription>{data.businesses.length} workspace{data.businesses.length === 1 ? '' : 's'}.</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="grid gap-2">
                        {data.businesses.length ? (
                          data.businesses.map((business) => (
                            <EditableBusiness
                              key={business.id}
                              business={business}
                              onSave={(body) => saveAndRefresh(() => updateBusiness(business.id, body), 'Business saved.')}
                            />
                          ))
                        ) : (
                          <EmptyState title="No businesses yet" description="Create your first business to start tracking spend." />
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </TabsContent>

              <TabsContent value="users">
                <div className="grid gap-4 lg:grid-cols-12">
                  <Card className="lg:col-span-4">
                    <CardHeader>
                      <CardTitle>Invite admin</CardTitle>
                      <CardDescription>Admins can read every business and edit settings.</CardDescription>
                    </CardHeader>
                    <CardContent className="grid gap-3">
                      <FieldText label="Username" value={userForm.username} onChange={(username) => setUserForm({ ...userForm, username })} />
                      <FieldText label="Display name" value={userForm.displayName} onChange={(displayName) => setUserForm({ ...userForm, displayName })} />
                      <FieldText label="Password" type="password" value={userForm.password} onChange={(password) => setUserForm({ ...userForm, password })} placeholder="12+ characters" />
                      <Button onClick={() => saveAndRefresh(() => createAdminUser(userForm), 'Admin created.')}>
                        <UserPlus className="h-3.5 w-3.5" /> Create admin
                      </Button>
                    </CardContent>
                  </Card>

                  <Card className="lg:col-span-8">
                    <CardHeader>
                      <CardTitle>Admin accounts</CardTitle>
                      <CardDescription>{data.users.length} active.</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="grid gap-2">
                        {data.users.map((admin) => (
                          <EditableUser
                            key={admin.id}
                            admin={admin}
                            onSave={(body) => saveAndRefresh(() => updateAdminUser(admin.id, body), 'Admin saved.')}
                            onPassword={(password) => {
                              if (password.length < 12) {
                                toast({ variant: 'destructive', title: 'Password too short', description: 'Use at least 12 characters.' });
                                return Promise.resolve(false);
                              }
                              return saveAndRefresh(
                                () => resetAdminUserPassword(admin.id, password),
                                admin.id === user?.id
                                  ? 'Password reset. Use it next time you log in.'
                                  : 'Password reset.',
                              );
                            }}
                            onActive={(active) =>
                              saveAndRefresh(
                                () => setAdminUserActive(admin.id, active),
                                active ? 'Admin activated.' : 'Admin deactivated.',
                              )
                            }
                          />
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </TabsContent>

              <TabsContent value="categories">
                <div className="grid gap-4 lg:grid-cols-12">
                  <Card className="lg:col-span-4">
                    <CardHeader>
                      <CardTitle>Create category</CardTitle>
                    </CardHeader>
                    <CardContent className="grid gap-3">
                      <FieldBusiness
                        label="Scope"
                        value={categoryForm.businessId}
                        businesses={businesses}
                        onChange={(businessId) => setCategoryForm({ ...categoryForm, businessId })}
                      />
                      <FieldText label="Name" value={categoryForm.name} onChange={(name) => setCategoryForm({ ...categoryForm, name })} />
                      <FieldText label="Tax code" value={categoryForm.taxCode} onChange={(taxCode) => setCategoryForm({ ...categoryForm, taxCode })} />
                      <FieldColor label="Color" value={categoryForm.color} onChange={(color) => setCategoryForm({ ...categoryForm, color })} />
                      <Button
                        onClick={() =>
                          saveAndRefresh(
                            () => createCategory({ ...categoryForm, businessId: categoryForm.businessId || null }),
                            'Category created.',
                          )
                        }
                      >
                        Create category
                      </Button>
                    </CardContent>
                  </Card>

                  <Card className="lg:col-span-8">
                    <CardHeader>
                      <CardTitle>Categories</CardTitle>
                      <CardDescription>{data.categories.length} defined.</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="grid gap-2">
                        {data.categories.length ? (
                          data.categories.map((category) => (
                            <EditableCategory
                              key={category.id}
                              category={category}
                              onSave={(body) => saveAndRefresh(() => updateCategory(category.id, body), 'Category saved.')}
                            />
                          ))
                        ) : (
                          <EmptyState title="No categories" description="Create your first category to start grouping spend." />
                        )}
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="lg:col-span-4">
                    <CardHeader>
                      <CardTitle>Create rule</CardTitle>
                      <CardDescription>Automatically tag transactions that match a pattern.</CardDescription>
                    </CardHeader>
                    <CardContent className="grid gap-3">
                      <FieldBusiness
                        label="Scope"
                        value={ruleForm.businessId}
                        businesses={businesses}
                        onChange={(businessId) => setRuleForm({ ...ruleForm, businessId })}
                      />
                      <FieldSelect
                        label="Category"
                        value={ruleForm.categoryId}
                        onChange={(categoryId) => setRuleForm({ ...ruleForm, categoryId })}
                        placeholder="Choose"
                        options={data.categories.map((category) => ({ value: category.id, label: category.name }))}
                      />
                      <FieldSelect
                        label="Match"
                        value={ruleForm.matchKind}
                        onChange={(matchKind) => setRuleForm({ ...ruleForm, matchKind })}
                        options={[
                          { value: 'merchant_contains', label: 'Merchant contains' },
                          { value: 'merchant_exact', label: 'Merchant exact' },
                          { value: 'plaid_category', label: 'Plaid category' },
                          { value: 'amount_range', label: 'Amount range' },
                        ]}
                      />
                      <FieldText label="Pattern" value={ruleForm.pattern} onChange={(pattern) => setRuleForm({ ...ruleForm, pattern })} />
                      <FieldText
                        label="Priority"
                        type="number"
                        value={String(ruleForm.priority)}
                        onChange={(priority) => setRuleForm({ ...ruleForm, priority: Number(priority) })}
                      />
                      <Button
                        onClick={() =>
                          saveAndRefresh(
                            () => createCategoryRule({ ...ruleForm, businessId: ruleForm.businessId || null }),
                            'Rule created.',
                          )
                        }
                      >
                        Create rule
                      </Button>
                    </CardContent>
                  </Card>

                  <Card className="lg:col-span-8">
                    <CardHeader>
                      <CardTitle>Rules</CardTitle>
                      <CardDescription>{data.rules.length} active rule{data.rules.length === 1 ? '' : 's'}.</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="grid gap-2">
                        {data.rules.length ? (
                          data.rules.map((rule) => (
                            <EditableRule
                              key={rule.id}
                              rule={rule}
                              categories={data.categories}
                              onSave={(body) => saveAndRefresh(() => updateCategoryRule(rule.id, body), 'Rule saved.')}
                            />
                          ))
                        ) : (
                          <EmptyState title="No rules yet" description="Rules auto-categorize transactions as they come in." />
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </TabsContent>

              <TabsContent value="connections">
                <Card>
                  <CardHeader>
                    <CardTitle>Connection management</CardTitle>
                    <CardDescription>Plaid and Gmail providers feeding this workspace.</CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-3">
                    <Button variant="outline" className="self-start" onClick={() => setConnectionsOpen(true)}>
                      Open connection manager
                    </Button>
                    <Separator />
                    <div className="grid gap-2">
                      {connections.length ? (
                        connections.map((connection) => (
                          <ListRow
                            key={connection.id ?? connection.label}
                            left={connection.label}
                            right={
                              <Badge variant={connection.status === 'live' ? 'success' : connection.status === 'reauth' ? 'warning' : 'muted'}>
                                {connection.kind} · {connection.status}
                              </Badge>
                            }
                          />
                        ))
                      ) : (
                        <EmptyState title="No connections yet" description="Open the connection manager to link Plaid or Gmail." />
                      )}
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="exports">
                <div className="grid gap-4 lg:grid-cols-12">
                  <Card className="lg:col-span-4">
                    <CardHeader>
                      <CardTitle>Audit export</CardTitle>
                      <CardDescription>Queue a month-to-date CSV bundle.</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <Button
                        onClick={() =>
                          saveAndRefresh(() => {
                            const now = new Date();
                            const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
                            const to = now.toISOString().slice(0, 10);
                            return createExport(from, to);
                          }, 'Export queued.')
                        }
                      >
                        Queue month-to-date export
                      </Button>
                    </CardContent>
                  </Card>
                  <Card className="lg:col-span-8">
                    <CardHeader>
                      <CardTitle>Recent exports</CardTitle>
                    </CardHeader>
                    <CardContent>
                      {data.exports.length ? (
                        <div className="grid gap-2">
                          {data.exports.map((job) => (
                            <ListRow
                              key={job.id}
                              left={`${job.dateFrom} → ${job.dateTo}`}
                              right={<Badge variant="muted">{job.status}</Badge>}
                            />
                          ))}
                        </div>
                      ) : (
                        <EmptyState title="No exports yet" description="Queued exports will appear here." />
                      )}
                    </CardContent>
                  </Card>
                </div>
              </TabsContent>

              <TabsContent value="audit">
                <Card>
                  <CardHeader>
                    <CardTitle>Audit log</CardTitle>
                    <CardDescription>
                      {filteredAudit.length} event{filteredAudit.length === 1 ? '' : 's'}
                      {query && ` matching "${query}"`}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {filteredAudit.length ? (
                      <div className="overflow-hidden rounded-md border border-ink2/10">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Action</TableHead>
                              <TableHead>Entity</TableHead>
                              <TableHead className="text-right">When</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {filteredAudit.slice(0, 200).map((row) => (
                              <TableRow key={row.id}>
                                <TableCell className="font-bold">{row.action}</TableCell>
                                <TableCell className="text-dim">{row.entityType}</TableCell>
                                <TableCell className="text-right text-xs text-dim">
                                  {new Date(row.createdAt).toLocaleString()}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    ) : (
                      <EmptyState title="No audit events" description="Actions you take here will be logged." />
                    )}
                  </CardContent>
                </Card>
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
        onRefresh={() => refresh().catch((error: Error) => toast({ variant: 'destructive', title: 'Refresh failed', description: error.message }))}
      />
    </div>
  );
}

// ─── Editable row components ───────────────────────────────────────────────

function EditableBusiness({
  business,
  onSave,
}: {
  business: AdminOverview['businesses'][number];
  onSave: (body: Partial<AdminOverview['businesses'][number]>) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(business);
  useEffect(() => setDraft(business), [business]);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border border-ink2/10 bg-[hsl(var(--color-sunken))]">
      <CollapsibleTrigger asChild>
        <button type="button" className="flex w-full items-center gap-3 px-4 py-3 text-left">
          <span className="h-6 w-1.5 rounded-full" style={{ background: business.color }} />
          <span className="min-w-0 flex-1">
            <span className="block font-bold text-ink">{business.name}</span>
            <span className="block truncate text-xs text-dim">{business.key} · {business.short}</span>
          </span>
          <Badge variant={business.active ? 'success' : 'muted'}>{business.active ? 'Active' : 'Disabled'}</Badge>
          <ChevronDown className={cn('h-4 w-4 text-dim transition-transform', open && 'rotate-180')} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid gap-3 border-t border-ink2/10 p-4 md:grid-cols-2">
          <FieldText label="Name" value={draft.name} onChange={(name) => setDraft({ ...draft, name })} />
          <FieldText label="Short code" value={draft.short} onChange={(short) => setDraft({ ...draft, short })} />
          <FieldText label="URL key" value={draft.key} onChange={(key) => setDraft({ ...draft, key })} />
          <FieldColor label="Color" value={draft.color} onChange={(color) => setDraft({ ...draft, color })} />
          <FieldSwitch label="Active" checked={draft.active} onCheckedChange={(active) => setDraft({ ...draft, active })} />
          <div className="flex items-end justify-end gap-2 md:col-span-2">
            <Button variant="outline" size="sm" onClick={() => { setDraft(business); setOpen(false); }}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => onSave(draft).then((ok) => ok && setOpen(false))}>
              <Save className="h-3.5 w-3.5" /> Save changes
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function EditableUser({
  admin,
  onSave,
  onPassword,
  onActive,
}: {
  admin: AdminOverview['users'][number];
  onSave: (body: { username?: string; displayName?: string }) => Promise<boolean>;
  onPassword: (password: string) => Promise<boolean | void>;
  onActive: (active: boolean) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(admin);
  const [password, setPassword] = useState('');
  useEffect(() => setDraft(admin), [admin]);

  const resetPassword = async () => {
    const ok = await onPassword(password);
    if (ok !== false) setPassword('');
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border border-ink2/10 bg-[hsl(var(--color-sunken))]">
      <CollapsibleTrigger asChild>
        <button type="button" className="flex w-full items-center gap-3 px-4 py-3 text-left">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-coral font-bold text-paper">
            {(admin.displayName || admin.username).slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-bold text-ink">{admin.displayName}</span>
            <span className="block truncate text-xs text-dim">{admin.username}</span>
          </span>
          {admin.totpEnabled && <Badge variant="muted">2FA</Badge>}
          <Badge variant={admin.active ? 'success' : 'muted'}>{admin.active ? 'Active' : 'Disabled'}</Badge>
          <ChevronDown className={cn('h-4 w-4 text-dim transition-transform', open && 'rotate-180')} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid gap-3 border-t border-ink2/10 p-4 md:grid-cols-2">
          <FieldText label="Username" value={draft.username} onChange={(username) => setDraft({ ...draft, username })} />
          <FieldText label="Display name" value={draft.displayName} onChange={(displayName) => setDraft({ ...draft, displayName })} />
          <FieldText label="New password" type="password" value={password} onChange={setPassword} placeholder="12+ characters" />
          <FieldSwitch label="Account active" checked={draft.active} onCheckedChange={(active) => { setDraft({ ...draft, active }); void onActive(active); }} />
          <div className="flex items-end justify-end gap-2 md:col-span-2">
            <Button variant="outline" size="sm" onClick={resetPassword} disabled={!password}>
              Reset password
            </Button>
            <Button size="sm" onClick={() => onSave({ username: draft.username, displayName: draft.displayName }).then((ok) => ok && setOpen(false))}>
              <Save className="h-3.5 w-3.5" /> Save changes
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function EditableCategory({
  category,
  onSave,
}: {
  category: AdminOverview['categories'][number];
  onSave: (body: Partial<AdminOverview['categories'][number]>) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(category);
  useEffect(() => setDraft(category), [category]);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border border-ink2/10 bg-[hsl(var(--color-sunken))]">
      <CollapsibleTrigger asChild>
        <button type="button" className="flex w-full items-center gap-3 px-4 py-3 text-left">
          <span className="h-4 w-4 rounded-sm" style={{ background: category.color ?? '#D97757' }} />
          <span className="min-w-0 flex-1">
            <span className="block font-bold text-ink">{category.name}</span>
            <span className="block truncate text-xs text-dim">{category.taxCode || 'No tax code'}</span>
          </span>
          <Badge variant={category.active ? 'success' : 'muted'}>{category.active ? 'Active' : 'Disabled'}</Badge>
          <ChevronDown className={cn('h-4 w-4 text-dim transition-transform', open && 'rotate-180')} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid gap-3 border-t border-ink2/10 p-4 md:grid-cols-2">
          <FieldText label="Name" value={draft.name} onChange={(name) => setDraft({ ...draft, name })} />
          <FieldText label="Tax code" value={draft.taxCode ?? ''} onChange={(taxCode) => setDraft({ ...draft, taxCode })} />
          <FieldColor label="Color" value={draft.color ?? '#D97757'} onChange={(color) => setDraft({ ...draft, color })} />
          <FieldSwitch label="Active" checked={draft.active} onCheckedChange={(active) => setDraft({ ...draft, active })} />
          <div className="flex items-end justify-end gap-2 md:col-span-2">
            <Button variant="outline" size="sm" onClick={() => { setDraft(category); setOpen(false); }}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => onSave(draft).then((ok) => ok && setOpen(false))}>
              <Save className="h-3.5 w-3.5" /> Save changes
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function EditableRule({
  rule,
  categories,
  onSave,
}: {
  rule: AdminOverview['rules'][number];
  categories: AdminOverview['categories'];
  onSave: (body: Partial<AdminOverview['rules'][number]>) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(rule);
  useEffect(() => setDraft(rule), [rule]);
  const categoryName = categories.find((c) => c.id === rule.categoryId)?.name ?? '—';
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border border-ink2/10 bg-[hsl(var(--color-sunken))]">
      <CollapsibleTrigger asChild>
        <button type="button" className="flex w-full items-center gap-3 px-4 py-3 text-left">
          <Badge variant="muted">{rule.matchKind}</Badge>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-mono text-sm text-ink">{rule.pattern || '(empty)'}</span>
            <span className="block truncate text-xs text-dim">→ {categoryName} · priority {rule.priority}</span>
          </span>
          <ChevronDown className={cn('h-4 w-4 text-dim transition-transform', open && 'rotate-180')} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid gap-3 border-t border-ink2/10 p-4 md:grid-cols-2">
          <FieldText label="Match kind" value={draft.matchKind} onChange={(matchKind) => setDraft({ ...draft, matchKind })} />
          <FieldText label="Pattern" value={draft.pattern} onChange={(pattern) => setDraft({ ...draft, pattern })} />
          <FieldText
            label="Priority"
            type="number"
            value={String(draft.priority)}
            onChange={(priority) => setDraft({ ...draft, priority: Number(priority) })}
          />
          <div className="flex items-end justify-end gap-2 md:col-span-2">
            <Button variant="outline" size="sm" onClick={() => { setDraft(rule); setOpen(false); }}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => onSave(draft).then((ok) => ok && setOpen(false))}>
              <Save className="h-3.5 w-3.5" /> Save changes
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ─── Field components ──────────────────────────────────────────────────────

function FieldText({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
    </div>
  );
}

function FieldSelect({
  label,
  value,
  onChange,
  options,
  placeholder = 'Choose',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function FieldBusiness({
  label,
  value,
  businesses,
  onChange,
}: {
  label: string;
  value: string;
  businesses: Business[];
  onChange: (value: string) => void;
}) {
  const options = [
    { value: 'global', label: 'Global (no business)' },
    ...businesses.map((business) => ({
      value: business.dbId ?? business.id,
      label: business.name,
    })),
  ];
  return (
    <FieldSelect
      label={label}
      value={value || 'global'}
      onChange={(next) => onChange(next === 'global' ? '' : next)}
      options={options}
    />
  );
}

function FieldColor({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-10 w-12 cursor-pointer rounded-md border border-ink2/30 bg-paper p-1"
        />
        <Input value={value} onChange={(event) => onChange(event.target.value)} className="font-mono" />
      </div>
    </div>
  );
}

function FieldSwitch({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-ink2/10 bg-paper px-3 py-2">
      <Label htmlFor={id} className="cursor-pointer">{label}</Label>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

function ListRow({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-ink2/8 bg-[hsl(var(--color-sunken))] px-3 py-2 text-sm">
      <span className="min-w-0 flex-1 truncate font-medium text-ink">{left}</span>
      <span className="shrink-0 text-dim">{right}</span>
    </div>
  );
}

// Local useId polyfill — keeps AdminPage self-contained without bumping React.
let idCounter = 0;
function useId() {
  const [id] = useState(() => `field-${++idCounter}`);
  return id;
}
