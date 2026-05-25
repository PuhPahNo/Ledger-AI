import { describe, expect, it } from 'vitest';
import { countDuplicateSubs, countNeedsReceipt, summarizeTransactions, totalSpend, transactionMatchesDirection } from './calc';
import type { Transaction } from '@/types/domain';

const rows: Transaction[] = [
  { id: '1', date: '2026-05-01', dateLabel: 'May 1', merchant: 'A', amount: -10, biz: 'b1', cat: 'Software', receipt: 'missing', src: 'Card', flag: 'no-receipt' },
  { id: '2', date: '2026-05-02', dateLabel: 'May 2', merchant: 'B', amount: -20, biz: 'b1', cat: 'Software', receipt: 'matched', src: 'Card', flag: 'dup-sub' },
  { id: '3', date: '2026-05-03', dateLabel: 'May 3', merchant: 'C', amount: 100, biz: 'b1', cat: 'Revenue', receipt: 'n/a', src: 'Bank' },
  { id: '4', date: '2026-05-04', dateLabel: 'May 4', merchant: 'Card Payment', amount: -500, biz: 'b1', cat: 'Transfers', categoryTaxCode: 'exclude_transfer', receipt: 'n/a', src: 'Bank' },
];

describe('dashboard calculations', () => {
  it('sums only outflows', () => {
    expect(totalSpend(rows)).toBe(-30);
  });

  it('summarizes cash movement without mixing transfers into operating spend', () => {
    expect(summarizeTransactions(rows)).toMatchObject({
      rows: 4,
      inflowCents: 10000,
      outflowCents: 53000,
      operatingOutflowCents: 3000,
      transferCents: 50000,
      netCents: -43000,
      missingReceipts: 1,
    });
  });

  it('matches transaction direction filters', () => {
    expect(transactionMatchesDirection(rows[2], 'inflow')).toBe(true);
    expect(transactionMatchesDirection(rows[0], 'operating-outflow')).toBe(true);
    expect(transactionMatchesDirection(rows[3], 'transfer')).toBe(true);
    expect(transactionMatchesDirection(rows[3], 'operating-outflow')).toBe(false);
  });

  it('counts missing receipts and duplicate subscription flags', () => {
    expect(countNeedsReceipt(rows, 'b1')).toBe(1);
    expect(countDuplicateSubs(rows, 'b1')).toBe(1);
  });
});
