import { http, useMockApi } from './client';
import { BUSINESSES, CATEGORIES, CONNECTIONS } from './mocks';

export interface AdminOverview {
  businesses: Array<{
    id: string;
    key: string;
    name: string;
    short: string;
    color: string;
    hue: number;
    active: boolean;
  }>;
  categories: Array<{ id: string; name: string; taxCode?: string | null; color?: string | null; businessId?: string | null; active: boolean }>;
  rules: Array<{ id: string; businessId?: string | null; categoryId: string; matchKind: string; pattern: string; priority: number }>;
  accounts: Array<{ id: string; name: string; mask?: string | null; kind: string; enabled: boolean; businessId?: string | null }>;
  users: Array<{ id: string; username: string; displayName: string; active: boolean; totpEnabled: boolean }>;
  exports: Array<{ id: string; status: string; dateFrom: string; dateTo: string; createdAt: string }>;
}

export type AdminUser = AdminOverview['users'][number];
export type AdminBusiness = AdminOverview['businesses'][number];
export type AdminCategory = AdminOverview['categories'][number];
export type AdminRule = AdminOverview['rules'][number];
export interface AuditLogRow {
  id: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export function getAdminOverview(): Promise<AdminOverview> {
  if (useMockApi) {
    return Promise.resolve({
      businesses: BUSINESSES.map((b) => ({ ...b, id: b.id, key: b.id, active: true })),
      categories: CATEGORIES.map((c, i) => ({ id: `cat-${i}`, name: c.name, active: true })),
      rules: [],
      accounts: CONNECTIONS.filter((c) => c.kind !== 'gmail').map((c, i) => ({
        id: `acct-${i}`,
        name: c.label,
        mask: c.mask,
        kind: c.kind,
        enabled: true,
      })),
      users: [{ id: 'mock-admin', username: 'admin', displayName: 'Ledger Admin', active: true, totpEnabled: false }],
      exports: [],
    });
  }
  return http<AdminOverview>('/admin/overview');
}

export function createExport(dateFrom: string, dateTo: string, businessId?: string | null) {
  return http<{ id: string; status: string }>('/exports', {
    method: 'POST',
    body: JSON.stringify({ dateFrom, dateTo, businessId }),
  });
}

export function listAuditLog(): Promise<AuditLogRow[]> {
  if (useMockApi) return Promise.resolve([]);
  return http<AuditLogRow[]>('/admin/audit-log');
}

export function createAdminUser(body: { username: string; displayName: string; password: string }): Promise<AdminUser> {
  if (useMockApi) return Promise.resolve({ id: crypto.randomUUID(), username: body.username, displayName: body.displayName, active: true, totpEnabled: false });
  return http<AdminUser>('/admin/users', { method: 'POST', body: JSON.stringify(body) });
}

export function updateAdminUser(id: string, body: { username?: string; displayName?: string }): Promise<AdminUser> {
  if (useMockApi) return Promise.resolve({ id, username: body.username ?? 'admin', displayName: body.displayName ?? 'Ledger Admin', active: true, totpEnabled: false });
  return http<AdminUser>(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

export function resetAdminUserPassword(id: string, password: string): Promise<AdminUser> {
  if (useMockApi) return Promise.resolve({ id, username: 'admin', displayName: 'Ledger Admin', active: true, totpEnabled: false });
  return http<AdminUser>(`/admin/users/${id}/password`, { method: 'PATCH', body: JSON.stringify({ password }) });
}

export function setAdminUserActive(id: string, active: boolean): Promise<AdminUser> {
  if (useMockApi) return Promise.resolve({ id, username: 'admin', displayName: 'Ledger Admin', active, totpEnabled: false });
  return http<AdminUser>(`/admin/users/${id}/active`, { method: 'PATCH', body: JSON.stringify({ active }) });
}

export function createBusiness(body: { key?: string; name: string; short: string; color: string; hue?: number; active?: boolean }): Promise<AdminBusiness> {
  if (useMockApi) return Promise.resolve({ id: crypto.randomUUID(), key: body.key ?? body.name.toLowerCase(), name: body.name, short: body.short, color: body.color, hue: body.hue ?? 0, active: body.active ?? true });
  return http<AdminBusiness>('/admin/businesses', { method: 'POST', body: JSON.stringify(body) });
}

export function updateBusiness(id: string, body: Partial<Pick<AdminBusiness, 'key' | 'name' | 'short' | 'color' | 'hue' | 'active'>>): Promise<AdminBusiness> {
  if (useMockApi) return Promise.resolve({ id, key: body.key ?? id, name: body.name ?? id, short: body.short ?? 'B', color: body.color ?? '#D97757', hue: body.hue ?? 0, active: body.active ?? true });
  return http<AdminBusiness>(`/admin/businesses/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

export function createCategory(body: { businessId?: string | null; name: string; taxCode?: string; color?: string }): Promise<AdminCategory> {
  if (useMockApi) return Promise.resolve({ id: crypto.randomUUID(), name: body.name, taxCode: body.taxCode, businessId: body.businessId, active: true });
  return http<AdminCategory>('/admin/categories', { method: 'POST', body: JSON.stringify(body) });
}

export function updateCategory(id: string, body: Partial<AdminCategory>): Promise<AdminCategory> {
  if (useMockApi) return Promise.resolve({ id, name: body.name ?? 'Category', taxCode: body.taxCode, businessId: body.businessId, active: body.active ?? true });
  return http<AdminCategory>(`/admin/categories/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

export function createCategoryRule(body: { businessId?: string | null; categoryId: string; matchKind: string; pattern: string; priority: number }): Promise<AdminRule> {
  if (useMockApi) return Promise.resolve({ id: crypto.randomUUID(), ...body });
  return http<AdminRule>('/admin/category-rules', { method: 'POST', body: JSON.stringify(body) });
}

export function updateCategoryRule(id: string, body: Partial<AdminRule>): Promise<AdminRule> {
  if (useMockApi) return Promise.resolve({ id, categoryId: body.categoryId ?? '', matchKind: body.matchKind ?? 'merchant_contains', pattern: body.pattern ?? '', priority: body.priority ?? 100 });
  return http<AdminRule>(`/admin/category-rules/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}
