import { describe, expect, it } from 'vitest';
import { resolveTransactionBusinessId } from './accountAssignment.js';

describe('resolveTransactionBusinessId', () => {
  it('uses the account-level business before the connection default', () => {
    expect(resolveTransactionBusinessId('business-account', 'business-connection')).toBe('business-account');
  });

  it('falls back to the connection business for unmapped accounts', () => {
    expect(resolveTransactionBusinessId(null, 'business-connection')).toBe('business-connection');
  });

  it('leaves transactions unassigned when neither mapping exists', () => {
    expect(resolveTransactionBusinessId(null, null)).toBeUndefined();
  });
});
