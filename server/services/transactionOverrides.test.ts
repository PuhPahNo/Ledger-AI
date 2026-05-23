import { describe, expect, it } from 'vitest';
import { normalizeTransactionOverride } from './transactionOverrides.js';

describe('normalizeTransactionOverride', () => {
  it('normalizes blank category and note overrides to null', () => {
    expect(normalizeTransactionOverride({ categoryId: '', note: '   ' })).toEqual({
      categoryId: null,
      note: null,
    });
  });

  it('preserves explicit business and category updates', () => {
    expect(normalizeTransactionOverride({
      businessId: 'business-1',
      categoryId: 'category-1',
      note: '  reviewed  ',
    })).toEqual({
      businessId: 'business-1',
      categoryId: 'category-1',
      note: 'reviewed',
    });
  });
});
