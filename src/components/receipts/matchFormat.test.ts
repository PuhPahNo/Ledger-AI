import { describe, expect, it } from 'vitest';
import type { Transaction } from '@/types/domain';
import type { MatchReason } from '@/types/receiptWorkflow';
import { rankByAmount, relativeTime, sortReasons } from './matchFormat';

describe('sortReasons', () => {
  it('puts conflicts first, then strongest to weakest', () => {
    const reasons: MatchReason[] = [
      { kind: 'merchant', text: 'm', strength: 'weak', score: 0.2 },
      { kind: 'amount', text: 'a', strength: 'strong', score: 1 },
      { kind: 'card', text: 'c', strength: 'conflict', score: 0 },
      { kind: 'date', text: 'd', strength: 'good', score: 0.6 },
    ];
    expect(sortReasons(reasons).map((row) => row.strength)).toEqual(['conflict', 'strong', 'good', 'weak']);
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-09-27T12:00:00Z');
  it('reads naturally', () => {
    expect(relativeTime('2026-09-27T11:59:40Z', now)).toBe('just now');
    expect(relativeTime('2026-09-27T11:15:00Z', now)).toBe('45m ago');
    expect(relativeTime('2026-09-27T07:00:00Z', now)).toBe('5h ago');
    expect(relativeTime('2026-09-26T10:00:00Z', now)).toBe('yesterday');
    expect(relativeTime('2026-09-24T12:00:00Z', now)).toBe('3d ago');
    expect(relativeTime(null, now)).toBe('');
  });
});

describe('rankByAmount', () => {
  const txn = (id: string, amount: number) => ({ id, amount }) as Transaction;
  it('orders by closeness to the receipt total, keeping order without one', () => {
    const rows = [txn('a', -10), txn('b', -54.5), txn('c', -60)];
    expect(rankByAmount(rows, 5499).map((row) => row.id)).toEqual(['b', 'c', 'a']);
    expect(rankByAmount(rows, null).map((row) => row.id)).toEqual(['a', 'b', 'c']);
  });
});
