import { describe, expect, it } from 'vitest';
import { countDuplicateSubs, countNeedsReceipt, totalSpend } from './calc';
import type { Transaction } from '@/types/domain';

const rows: Transaction[] = [
  { id: '1', date: '2026-05-01', dateLabel: 'May 1', merchant: 'A', amount: -10, biz: 'b1', cat: 'Software', receipt: 'missing', src: 'Card', flag: 'no-receipt' },
  { id: '2', date: '2026-05-02', dateLabel: 'May 2', merchant: 'B', amount: -20, biz: 'b1', cat: 'Software', receipt: 'matched', src: 'Card', flag: 'dup-sub' },
  { id: '3', date: '2026-05-03', dateLabel: 'May 3', merchant: 'C', amount: 100, biz: 'b1', cat: 'Revenue', receipt: 'n/a', src: 'Bank' },
];

describe('dashboard calculations', () => {
  it('sums only outflows', () => {
    expect(totalSpend(rows)).toBe(-30);
  });

  it('counts missing receipts and duplicate subscription flags', () => {
    expect(countNeedsReceipt(rows, 'b1')).toBe(1);
    expect(countDuplicateSubs(rows, 'b1')).toBe(1);
  });
});
