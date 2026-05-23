import { describe, expect, it } from 'vitest';
import { canSetAdminActive } from './adminGuards.js';

describe('canSetAdminActive', () => {
  it('blocks deactivating the last active admin', () => {
    expect(canSetAdminActive({
      targetCurrentlyActive: true,
      nextActive: false,
      remainingActiveAdmins: 0,
    })).toBe(false);
  });

  it('allows deactivation when another admin remains active', () => {
    expect(canSetAdminActive({
      targetCurrentlyActive: true,
      nextActive: false,
      remainingActiveAdmins: 1,
    })).toBe(true);
  });

  it('allows reactivating an admin', () => {
    expect(canSetAdminActive({
      targetCurrentlyActive: false,
      nextActive: true,
      remainingActiveAdmins: 0,
    })).toBe(true);
  });
});
