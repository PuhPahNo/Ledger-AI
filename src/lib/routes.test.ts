import { describe, expect, it } from 'vitest';
import { parseHash, resolveNavTarget, routeToHash } from './routes';

describe('parseHash', () => {
  it('lands on Home for empty and unknown hashes', () => {
    expect(parseHash('')).toEqual({ view: 'home' });
    expect(parseHash('#')).toEqual({ view: 'home' });
    expect(parseHash('#nope')).toEqual({ view: 'home' });
  });

  it('redirects retired pages to their new home', () => {
    expect(parseHash('#dashboard')).toEqual({ view: 'home' });
    expect(parseHash('#inbox')).toEqual({ view: 'home' });
    expect(parseHash('#receipts')).toEqual({ view: 'transactions', mode: 'receipts' });
    expect(parseHash('#cash-flow')).toEqual({ view: 'reports', tab: 'overview' });
    expect(parseHash('#insights')).toEqual({ view: 'reports', tab: 'overview' });
    expect(parseHash('#balances')).toEqual({ view: 'reports', tab: 'accounts' });
    expect(parseHash('#admin')).toEqual({ view: 'settings', section: 'businesses' });
  });

  it('maps old admin tabs onto the merged settings sections', () => {
    expect(parseHash('#admin/exports')).toEqual({ view: 'settings', section: 'data' });
    expect(parseHash('#admin/audit')).toEqual({ view: 'settings', section: 'data' });
    expect(parseHash('#admin/rules')).toEqual({ view: 'settings', section: 'categories' });
    expect(parseHash('#admin/tags')).toEqual({ view: 'settings', section: 'categories' });
    expect(parseHash('#admin/users')).toEqual({ view: 'settings', section: 'security' });
    expect(parseHash('#admin/connections')).toEqual({ view: 'settings', section: 'businesses' });
  });

  it('reads sub-pages and falls back to the default one when unknown', () => {
    expect(parseHash('#transactions/receipts')).toEqual({ view: 'transactions', mode: 'receipts' });
    expect(parseHash('#/reports/close')).toEqual({ view: 'reports', tab: 'close' });
    expect(parseHash('#reports/bogus')).toEqual({ view: 'reports', tab: 'overview' });
    expect(parseHash('#settings/data')).toEqual({ view: 'settings', section: 'data' });
    expect(parseHash('#assistant')).toEqual({ view: 'assistant' });
  });
});

describe('routeToHash', () => {
  it('round-trips every route and omits default sub-pages', () => {
    const hashes = ['', '#transactions', '#transactions/receipts', '#reports', '#reports/accounts', '#reports/close', '#assistant', '#settings', '#settings/categories', '#settings/security', '#settings/data'];
    for (const hash of hashes) expect(routeToHash(parseHash(hash))).toBe(hash);
  });
});

describe('resolveNavTarget', () => {
  it('accepts views, legacy names and routes', () => {
    expect(resolveNavTarget('reports')).toEqual({ view: 'reports', tab: 'overview' });
    expect(resolveNavTarget('balances')).toEqual({ view: 'reports', tab: 'accounts' });
    expect(resolveNavTarget({ view: 'settings', section: 'data' })).toEqual({ view: 'settings', section: 'data' });
  });

  it('uses close-readiness filters.tab for admin targets', () => {
    expect(resolveNavTarget('admin', { tab: 'exports' })).toEqual({ view: 'settings', section: 'data' });
    expect(resolveNavTarget('admin', { tab: 'connections' })).toEqual({ view: 'settings', section: 'businesses' });
    expect(resolveNavTarget('admin')).toEqual({ view: 'settings', section: 'businesses' });
  });
});
