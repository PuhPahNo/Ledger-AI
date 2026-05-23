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
  categories: Array<{ id: string; name: string; taxCode?: string | null; businessId?: string | null; active: boolean }>;
  rules: Array<{ id: string; categoryId: string; matchKind: string; pattern: string; priority: number }>;
  accounts: Array<{ id: string; name: string; mask?: string | null; kind: string; enabled: boolean; businessId?: string | null }>;
  users: Array<{ id: string; username: string; displayName: string; active: boolean; totpEnabled: boolean }>;
  exports: Array<{ id: string; status: string; dateFrom: string; dateTo: string; createdAt: string }>;
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
