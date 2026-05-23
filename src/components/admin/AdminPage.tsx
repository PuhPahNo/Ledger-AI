import { useEffect, useMemo, useState } from 'react';
import { Save, UserPlus } from 'lucide-react';
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
import { colors, fonts, radii } from '@/theme/tokens';
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
  const [tab, setTab] = useState<Tab>('businesses');
  const [data, setData] = useState<AdminOverview | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [auditRows, setAuditRows] = useState<AuditLogRow[]>([]);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [userForm, setUserForm] = useState({ username: '', displayName: '', password: '' });
  const [businessForm, setBusinessForm] = useState({ key: '', name: '', short: '', color: '#D97757', hue: 24 });
  const [categoryForm, setCategoryForm] = useState({ name: '', taxCode: '', color: '#D97757', businessId: '' });
  const [ruleForm, setRuleForm] = useState({ categoryId: '', businessId: '', matchKind: 'merchant_contains', pattern: '', priority: 100 });

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
    refresh().catch((error: Error) => setStatus(error.message));
  }, []);

  const businesses = useMemo<Business[]>(() => (data?.businesses ?? []).map((business) => ({
    id: business.key,
    dbId: business.id,
    name: business.name,
    short: business.short,
    color: business.color,
    hue: business.hue,
    active: business.active,
  })), [data]);

  const saveAndRefresh = async (work: () => Promise<unknown>, message: string): Promise<boolean> => {
    try {
      setStatus('Saving...');
      await work();
      await refresh();
      setStatus(message);
      return true;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Save failed.');
      return false;
    }
  };

  const filteredAudit = auditRows.filter((row) => !query || `${row.action} ${row.entityType} ${row.entityId ?? ''}`.toLowerCase().includes(query.toLowerCase()));

  return (
    <div style={{ minHeight: '100vh', background: colors.bg, color: colors.ink, fontFamily: fonts.sans, padding: 14 }}>
      <HeaderBar
        onUploadReceipt={() => undefined}
        currentView="admin"
        onViewChange={onViewChange}
        onLogout={onLogout}
        user={user}
        query={query}
        onQueryChange={setQuery}
      />

      <main style={{ display: 'grid', gap: 12, marginTop: 10 }}>
        <section style={heroStyle}>
          <div>
            <div style={{ fontFamily: fonts.display, fontSize: 30, fontWeight: 900 }}>Admin Settings</div>
            <div style={{ color: colors.dim, fontSize: 13 }}>Businesses, users, categories, connections, exports, and audit history.</div>
          </div>
          <span style={{ flex: 1 }} />
          {status && <div style={{ color: colors.dim, fontSize: 12 }}>{status}</div>}
        </section>

        <div style={{ display: 'flex', gap: 6, background: colors.paper, borderRadius: radii.pill, padding: 4, width: 'fit-content' }}>
          {tabs.map((item) => (
            <button key={item.id} type="button" onClick={() => setTab(item.id)} style={tabButtonStyle(tab === item.id)}>
              {item.label}
            </button>
          ))}
        </div>

        {tab === 'businesses' && data && (
          <Grid>
            <Panel title="Create Business" span={4}>
              <Input label="Name" value={businessForm.name} onChange={(name) => setBusinessForm({ ...businessForm, name })} />
              <Input label="Short Code" value={businessForm.short} onChange={(short) => setBusinessForm({ ...businessForm, short })} />
              <Input label="URL Key" value={businessForm.key} onChange={(key) => setBusinessForm({ ...businessForm, key })} />
              <Input label="Color" type="color" value={businessForm.color} onChange={(color) => setBusinessForm({ ...businessForm, color })} />
              <Action onClick={() => saveAndRefresh(() => createBusiness({ ...businessForm, key: businessForm.key || undefined }), 'Business created.')}>
                <Save size={14} /> Create business
              </Action>
            </Panel>
            <Panel title="Business Directory" span={8}>
              {data.businesses.map((business) => (
                <EditableBusiness key={business.id} business={business} onSave={(body) => saveAndRefresh(() => updateBusiness(business.id, body), 'Business saved.')} />
              ))}
            </Panel>
          </Grid>
        )}

        {tab === 'users' && data && (
          <Grid>
            <Panel title="Create Admin" span={4}>
              <Input label="Username" value={userForm.username} onChange={(username) => setUserForm({ ...userForm, username })} />
              <Input label="Display Name" value={userForm.displayName} onChange={(displayName) => setUserForm({ ...userForm, displayName })} />
              <Input label="Password" type="password" value={userForm.password} onChange={(password) => setUserForm({ ...userForm, password })} />
              <Action onClick={() => saveAndRefresh(() => createAdminUser(userForm), 'Admin created.')}>
                <UserPlus size={14} /> Create admin
              </Action>
            </Panel>
            <Panel title="Admin Accounts" span={8}>
              {data.users.map((admin) => (
                <EditableUser
                  key={admin.id}
                  user={admin}
                  onSave={(body) => saveAndRefresh(() => updateAdminUser(admin.id, body), 'Admin saved.')}
                  onPassword={(password) => {
                    if (password.length < 12) {
                      setStatus('Password must be at least 12 characters.');
                      return Promise.resolve(false);
                    }
                    return saveAndRefresh(
                      () => resetAdminUserPassword(admin.id, password),
                      admin.id === user?.id
                        ? 'Password reset. Use the new password next time you log in.'
                        : 'Password reset.',
                    );
                  }}
                  onActive={(active) => saveAndRefresh(() => setAdminUserActive(admin.id, active), active ? 'Admin activated.' : 'Admin deactivated.')}
                />
              ))}
            </Panel>
          </Grid>
        )}

        {tab === 'categories' && data && (
          <Grid>
            <Panel title="Create Category" span={4}>
              <BusinessSelect value={categoryForm.businessId} businesses={businesses} onChange={(businessId) => setCategoryForm({ ...categoryForm, businessId })} />
              <Input label="Name" value={categoryForm.name} onChange={(name) => setCategoryForm({ ...categoryForm, name })} />
              <Input label="Tax Code" value={categoryForm.taxCode} onChange={(taxCode) => setCategoryForm({ ...categoryForm, taxCode })} />
              <Input label="Color" type="color" value={categoryForm.color} onChange={(color) => setCategoryForm({ ...categoryForm, color })} />
              <Action onClick={() => saveAndRefresh(() => createCategory({ ...categoryForm, businessId: categoryForm.businessId || null }), 'Category created.')}>
                Create category
              </Action>
            </Panel>
            <Panel title="Categories" span={8}>
              {data.categories.map((category) => (
                <EditableCategory key={category.id} category={category} onSave={(body) => saveAndRefresh(() => updateCategory(category.id, body), 'Category saved.')} />
              ))}
            </Panel>
            <Panel title="Create Rule" span={4}>
              <BusinessSelect value={ruleForm.businessId} businesses={businesses} onChange={(businessId) => setRuleForm({ ...ruleForm, businessId })} />
              <Select label="Category" value={ruleForm.categoryId} onChange={(categoryId) => setRuleForm({ ...ruleForm, categoryId })} options={data.categories.map((category) => ({ value: category.id, label: category.name }))} />
              <Select label="Match" value={ruleForm.matchKind} onChange={(matchKind) => setRuleForm({ ...ruleForm, matchKind })} options={[
                { value: 'merchant_contains', label: 'Merchant contains' },
                { value: 'merchant_exact', label: 'Merchant exact' },
                { value: 'plaid_category', label: 'Plaid category' },
                { value: 'amount_range', label: 'Amount range' },
              ]} />
              <Input label="Pattern" value={ruleForm.pattern} onChange={(pattern) => setRuleForm({ ...ruleForm, pattern })} />
              <Input label="Priority" type="number" value={String(ruleForm.priority)} onChange={(priority) => setRuleForm({ ...ruleForm, priority: Number(priority) })} />
              <Action onClick={() => saveAndRefresh(() => createCategoryRule({ ...ruleForm, businessId: ruleForm.businessId || null }), 'Rule created.')}>
                Create rule
              </Action>
            </Panel>
            <Panel title="Rules" span={8}>
              {data.rules.map((rule) => (
                <EditableRule key={rule.id} rule={rule} onSave={(body) => saveAndRefresh(() => updateCategoryRule(rule.id, body), 'Rule saved.')} />
              ))}
            </Panel>
          </Grid>
        )}

        {tab === 'connections' && (
          <Grid>
            <Panel title="Connection Management" span={12}>
              <Action onClick={() => setConnectionsOpen(true)}>Open connection manager</Action>
              <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
                {connections.map((connection) => <Row key={connection.id ?? connection.label} left={connection.label} right={`${connection.kind} / ${connection.status}`} />)}
              </div>
            </Panel>
          </Grid>
        )}

        {tab === 'exports' && data && (
          <Grid>
            <Panel title="Audit Export" span={4}>
              <Action onClick={() => saveAndRefresh(() => {
                const now = new Date();
                const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
                const to = now.toISOString().slice(0, 10);
                return createExport(from, to);
              }, 'Export queued.')}>Queue month-to-date export</Action>
            </Panel>
            <Panel title="Recent Exports" span={8}>
              {data.exports.map((job) => <Row key={job.id} left={`${job.dateFrom} to ${job.dateTo}`} right={job.status} />)}
            </Panel>
          </Grid>
        )}

        {tab === 'audit' && (
          <Grid>
            <Panel title="Audit Log" span={12}>
              {filteredAudit.map((row) => (
                <Row key={row.id} left={`${row.action} ${row.entityType}`} right={new Date(row.createdAt).toLocaleString()} />
              ))}
              {!filteredAudit.length && <div style={{ color: colors.dim, fontSize: 13 }}>No audit rows match this search.</div>}
            </Panel>
          </Grid>
        )}
      </main>

      <ConnectionsManager
        open={connectionsOpen}
        businesses={businesses}
        connections={connections}
        accounts={accounts}
        onClose={() => setConnectionsOpen(false)}
        onRefresh={() => refresh().catch((error: Error) => setStatus(error.message))}
      />
    </div>
  );
}

function EditableBusiness({ business, onSave }: { business: AdminOverview['businesses'][number]; onSave: (body: Partial<AdminOverview['businesses'][number]>) => void }) {
  const [draft, setDraft] = useState(business);
  useEffect(() => setDraft(business), [business]);
  return (
    <div style={editableRowStyle}>
      <Input label="Name" value={draft.name} onChange={(name) => setDraft({ ...draft, name })} />
      <Input label="Short" value={draft.short} onChange={(short) => setDraft({ ...draft, short })} />
      <Input label="Key" value={draft.key} onChange={(key) => setDraft({ ...draft, key })} />
      <Input label="Color" type="color" value={draft.color} onChange={(color) => setDraft({ ...draft, color })} />
      <label style={toggleStyle}><input type="checkbox" checked={draft.active} onChange={(event) => setDraft({ ...draft, active: event.target.checked })} /> Active</label>
      <Action compact onClick={() => onSave(draft)}>Save</Action>
    </div>
  );
}

function EditableUser({
  user,
  onSave,
  onPassword,
  onActive,
}: {
  user: AdminOverview['users'][number];
  onSave: (body: { username?: string; displayName?: string }) => void;
  onPassword: (password: string) => Promise<boolean> | boolean | void;
  onActive: (active: boolean) => void;
}) {
  const [draft, setDraft] = useState(user);
  const [password, setPassword] = useState('');
  useEffect(() => setDraft(user), [user]);
  const resetPassword = async () => {
    const ok = await onPassword(password);
    if (ok !== false) setPassword('');
  };
  return (
    <div style={editableRowStyle}>
      <Input label="Username" value={draft.username} onChange={(username) => setDraft({ ...draft, username })} />
      <Input label="Display" value={draft.displayName} onChange={(displayName) => setDraft({ ...draft, displayName })} />
      <Input label="New Password" type="password" value={password} onChange={setPassword} />
      <label style={toggleStyle}><input type="checkbox" checked={draft.active} onChange={(event) => onActive(event.target.checked)} /> Active</label>
      <Action compact onClick={() => onSave({ username: draft.username, displayName: draft.displayName })}>Save</Action>
      <Action compact onClick={resetPassword}>Reset</Action>
    </div>
  );
}

function EditableCategory({ category, onSave }: { category: AdminOverview['categories'][number]; onSave: (body: Partial<AdminOverview['categories'][number]>) => void }) {
  const [draft, setDraft] = useState(category);
  useEffect(() => setDraft(category), [category]);
  return (
    <div style={editableRowStyle}>
      <Input label="Name" value={draft.name} onChange={(name) => setDraft({ ...draft, name })} />
      <Input label="Tax" value={draft.taxCode ?? ''} onChange={(taxCode) => setDraft({ ...draft, taxCode })} />
      <Input label="Color" type="color" value={draft.color ?? '#D97757'} onChange={(color) => setDraft({ ...draft, color })} />
      <label style={toggleStyle}><input type="checkbox" checked={draft.active} onChange={(event) => setDraft({ ...draft, active: event.target.checked })} /> Active</label>
      <Action compact onClick={() => onSave(draft)}>Save</Action>
    </div>
  );
}

function EditableRule({ rule, onSave }: { rule: AdminOverview['rules'][number]; onSave: (body: Partial<AdminOverview['rules'][number]>) => void }) {
  const [draft, setDraft] = useState(rule);
  useEffect(() => setDraft(rule), [rule]);
  return (
    <div style={editableRowStyle}>
      <Input label="Kind" value={draft.matchKind} onChange={(matchKind) => setDraft({ ...draft, matchKind })} />
      <Input label="Pattern" value={draft.pattern} onChange={(pattern) => setDraft({ ...draft, pattern })} />
      <Input label="Priority" type="number" value={String(draft.priority)} onChange={(priority) => setDraft({ ...draft, priority: Number(priority) })} />
      <Action compact onClick={() => onSave(draft)}>Save</Action>
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(12, minmax(0, 1fr))' }}>{children}</div>;
}

function Panel({ title, span, children }: { title: string; span: number; children: React.ReactNode }) {
  return (
    <section style={{ gridColumn: `span ${span}`, background: colors.paper, borderRadius: radii.tile, padding: 16, minHeight: 160, display: 'grid', gap: 10, alignContent: 'start' }}>
      <div style={{ fontFamily: fonts.display, fontWeight: 900, fontSize: 17 }}>{title}</div>
      {children}
    </section>
  );
}

function Input({ label, value, onChange, type = 'text' }: { label: string; value: string; onChange: (value: string) => void; type?: string }) {
  return (
    <label style={{ display: 'grid', gap: 4, fontSize: 11, color: colors.dim, fontWeight: 900 }}>
      {label}
      <input type={type} value={value} onChange={(event) => onChange(event.target.value)} style={inputStyle} />
    </label>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }> }) {
  return (
    <label style={{ display: 'grid', gap: 4, fontSize: 11, color: colors.dim, fontWeight: 900 }}>
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)} style={inputStyle}>
        <option value="">Choose</option>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function BusinessSelect({ value, businesses, onChange }: { value: string; businesses: Business[]; onChange: (value: string) => void }) {
  return <Select label="Business" value={value} onChange={onChange} options={[{ value: '', label: 'Global' }, ...businesses.map((business) => ({ value: business.dbId ?? business.id, label: business.name }))]} />;
}

function Action({ children, onClick, compact = false }: { children: React.ReactNode; onClick: () => void; compact?: boolean }) {
  return (
    <button type="button" onClick={onClick} style={{ ...buttonStyle, padding: compact ? '7px 10px' : '10px 13px' }}>
      {children}
    </button>
  );
}

function Row({ left, right }: { left: string; right: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, padding: '8px 0', borderBottom: '1px solid rgba(44,37,32,0.08)' }}>
      <span>{left}</span>
      <span style={{ color: colors.dim }}>{right}</span>
    </div>
  );
}

const heroStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  background: colors.paper,
  borderRadius: radii.tile,
  padding: 18,
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  border: `1px solid ${colors.ink2}`,
  borderRadius: 10,
  padding: '8px 10px',
  background: colors.bg,
  color: colors.ink,
  fontSize: 13,
  boxSizing: 'border-box',
};

const editableRowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(6, minmax(0, 1fr))',
  gap: 8,
  alignItems: 'end',
  padding: 10,
  borderRadius: radii.tile,
  background: colors.bg,
};

const toggleStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 12,
  color: colors.dim,
  fontWeight: 800,
};

const buttonStyle: React.CSSProperties = {
  border: 'none',
  borderRadius: radii.pill,
  background: colors.ink,
  color: colors.lemon,
  fontWeight: 900,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 7,
  fontSize: 12,
};

function tabButtonStyle(active: boolean): React.CSSProperties {
  return {
    border: 'none',
    borderRadius: radii.pill,
    background: active ? colors.ink : 'transparent',
    color: active ? colors.lemon : colors.dim,
    padding: '8px 12px',
    cursor: 'pointer',
    fontWeight: 900,
    fontSize: 12,
  };
}
