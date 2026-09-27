import { useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import type { AdminOverview, AuditLogRow } from '@/api';
import type { Account, Business, Connection, CurrentUser } from '@/types/domain';
import type { SettingsSection } from '@/types/navigation';
import { cn } from '@/lib/cn';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { SaveAndRefresh } from '../admin/fields';
import { AuditTab } from '../admin/tabs/AuditTab';
import { BusinessesTab } from '../admin/tabs/BusinessesTab';
import { CategoriesTab } from '../admin/tabs/CategoriesTab';
import { ConnectionsTab } from '../admin/tabs/ConnectionsTab';
import { ExportsTab } from '../admin/tabs/ExportsTab';
import { RulesTab } from '../admin/tabs/RulesTab';
import { TagsTab } from '../admin/tabs/TagsTab';
import { UsersTab } from '../admin/tabs/UsersTab';
import { AccountSecurityPanel } from '../shell/AccountSecurityPanel';
import { QuickbooksSettings } from '../quickbooks/QuickbooksSettings';
import { LearnedRulesSettings } from './LearnedRulesSettings';
import { ReceiptRulesSettings } from '../receipts/ReceiptRulesSettings';

/** Everything a settings section may need; loaded once by SettingsPage. */
export interface SettingsSectionProps {
  data: AdminOverview;
  businesses: Business[];
  connections: Connection[];
  accounts: Account[];
  auditRows: AuditLogRow[];
  /** Sidebar search text (used by the audit log). */
  query: string;
  user?: CurrentUser;
  saveAndRefresh: SaveAndRefresh;
  openConnectionsManager: () => void;
}

export interface SettingsSectionDefinition {
  id: SettingsSection;
  label: string;
  description: string;
  component: ComponentType<SettingsSectionProps>;
  /** Show the sidebar search box while this section is open. */
  searchPlaceholder?: string;
}

function BusinessesAndAccounts(props: SettingsSectionProps) {
  return (
    <div className="grid gap-4">
      <BusinessesTab data={props.data} saveAndRefresh={props.saveAndRefresh} />
      <ConnectionsTab connections={props.connections} onOpenConnections={props.openConnectionsManager} />
      <QuickbooksSettings businesses={props.businesses} />
    </div>
  );
}

type CategorySub = 'categories' | 'rules' | 'learned' | 'tags';

function CategoriesAndRules(props: SettingsSectionProps) {
  const [sub, setSub] = useState<CategorySub>('categories');
  const subs: Array<{ id: CategorySub; label: string; render: () => ReactNode }> = [
    { id: 'categories', label: 'Categories', render: () => <CategoriesTab data={props.data} businesses={props.businesses} saveAndRefresh={props.saveAndRefresh} /> },
    { id: 'rules', label: 'Rules', render: () => <RulesTab data={props.data} businesses={props.businesses} saveAndRefresh={props.saveAndRefresh} /> },
    { id: 'learned', label: 'Learned', render: () => <LearnedRulesSettings /> },
    { id: 'tags', label: 'Tags', render: () => <TagsTab /> },
  ];
  const active = subs.find((item) => item.id === sub) ?? subs[0];
  return (
    <div className="grid gap-3">
      <SubNav items={subs} active={active.id} onChange={setSub} label="Categories and rules" />
      {active.render()}
    </div>
  );
}

function UsersAndSecurity(props: SettingsSectionProps) {
  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Your sign-in</CardTitle>
          <CardDescription>Password and authenticator for {props.user?.displayName ?? 'your account'}.</CardDescription>
        </CardHeader>
        <CardContent>
          <AccountSecurityPanel user={props.user} />
        </CardContent>
      </Card>
      <UsersTab data={props.data} businesses={props.businesses} user={props.user} saveAndRefresh={props.saveAndRefresh} />
    </div>
  );
}

function DataSection(props: SettingsSectionProps) {
  const needle = props.query.toLowerCase();
  const rows = props.auditRows.filter(
    (row) => !needle || `${row.action} ${row.entityType} ${row.entityId ?? ''}`.toLowerCase().includes(needle),
  );
  return (
    <div className="grid gap-4">
      <ExportsTab data={props.data} saveAndRefresh={props.saveAndRefresh} />
      <AuditTab rows={rows} query={props.query} />
    </div>
  );
}

/**
 * The Settings sections, in display order. To add one (e.g. phase 2's QuickBooks
 * connection): add its id to `SettingsSection` in types/navigation.ts and to
 * SETTINGS_SECTION_IDS in lib/routes.ts, then append an entry here. URL: #settings/<id>.
 */
export const SETTINGS_SECTIONS: SettingsSectionDefinition[] = [
  { id: 'businesses', label: 'Businesses & accounts', description: 'Businesses, and the bank, card and Gmail connections feeding them.', component: BusinessesAndAccounts },
  { id: 'categories', label: 'Categories & rules', description: 'Categories, auto-categorization rules and custom tags.', component: CategoriesAndRules },
  { id: 'receipts', label: 'Receipt rules', description: 'When a transaction doesn’t need a receipt: a small-purchase threshold and merchant rules.', component: ReceiptRulesSettings },
  { id: 'security', label: 'Users & security', description: 'Your password and 2FA, team members, and receipt uploaders.', component: UsersAndSecurity },
  { id: 'data', label: 'Data', description: 'Audit exports and the audit log.', component: DataSection, searchPlaceholder: 'Search audit log…' },
];

export function SubNav<T extends string>({
  items,
  active,
  onChange,
  label,
}: {
  items: Array<{ id: T; label: string }>;
  active: T;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex w-full overflow-x-auto rounded-full bg-paper p-1 shadow-xs sm:w-fit">
      {items.map((item) => {
        const selected = item.id === active;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(item.id)}
            className={cn(
              'inline-flex min-h-10 shrink-0 items-center justify-center whitespace-nowrap rounded-full px-4 text-xs font-bold transition-colors sm:min-h-9',
              selected ? 'bg-inverse text-inverse-foreground' : 'text-dim hover:text-ink',
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
