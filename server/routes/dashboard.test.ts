import { describe, expect, it } from 'vitest';
import { flowBucketWindows } from './dashboard.js';

describe('flowBucketWindows', () => {
  it('uses daily buckets for month view', () => {
    const result = flowBucketWindows('2026-06-01', '2026-06-30', 'month');
    expect(result.granularity).toBe('day');
    expect(result.windows).toHaveLength(30);
    expect(result.windows[0]).toMatchObject({ from: '2026-06-01', to: '2026-06-01' });
  });

  it('uses weekly buckets for last 3 months', () => {
    const result = flowBucketWindows('2026-04-01', '2026-06-30', 'last3');
    expect(result.granularity).toBe('week');
    expect(result.windows[0]).toMatchObject({ from: '2026-04-01', to: '2026-04-07' });
    expect(result.windows.at(-1)?.to).toBe('2026-06-30');
  });

  it('uses monthly buckets for YTD and trailing annual views', () => {
    const ytd = flowBucketWindows('2026-01-01', '2026-06-30', 'ytd');
    const annual = flowBucketWindows('2025-07-01', '2026-06-30', 'last12');
    expect(ytd.granularity).toBe('month');
    expect(ytd.windows).toHaveLength(6);
    expect(annual.granularity).toBe('month');
    expect(annual.windows).toHaveLength(12);
  });
});

describe('month-close sign-off keys', async () => {
  const {
    closeMonthBounds,
    closeMonthForRange,
    closeSignoffKey,
    legacyCloseSignoffMonth,
    parseCloseSignoff,
  } = await import('./dashboard/closeReadiness.js');

  it('keys sign-off by business and calendar month', () => {
    expect(closeSignoffKey('all', '2026-09')).toBe('close_signoff:all:2026-09');
    // Insights defaults `to` to today — any range inside September maps to the same month.
    expect(closeMonthForRange('2026-09-01', '2026-09-27')).toBe('2026-09');
    expect(closeMonthForRange('2026-09-01', '2026-09-28')).toBe('2026-09');
    expect(closeMonthForRange('2026-08-01', '2026-09-27')).toBeNull();
    expect(closeMonthForRange('bad', '2026-09-27')).toBeNull();
  });

  it('computes full month bounds for sign-off', () => {
    expect(closeMonthBounds('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });

  it('maps legacy range keys to the month they fall in', () => {
    expect(legacyCloseSignoffMonth('close_signoff:all:2026-09-01:2026-09-14', 'all')).toBe('2026-09');
    expect(legacyCloseSignoffMonth('close_signoff:draft-sharks:2026-09-01:2026-09-14', 'all')).toBeNull();
    expect(legacyCloseSignoffMonth('close_signoff:all:2026-08-20:2026-09-14', 'all')).toBeNull();
    expect(legacyCloseSignoffMonth('close_signoff:all:2026-09', 'all')).toBeNull();
  });

  it('parses stored sign-off values defensively', () => {
    expect(parseCloseSignoff(null)).toEqual({ signedOff: false, signedOffAt: null });
    expect(parseCloseSignoff('{"signedOffAt":"2026-09-02T10:00:00.000Z"}')).toEqual({
      signedOff: true,
      signedOffAt: '2026-09-02T10:00:00.000Z',
    });
    expect(parseCloseSignoff('not json')).toEqual({ signedOff: true, signedOffAt: null });
  });
});

describe('summary aggregation', async () => {
  const { movementForWindow } = await import('./dashboard/cashFlowData.js');
  const { summarizeBreakdownRows } = await import('./dashboard/summaryRoutes.js');

  it('sums daily business rows into windows', () => {
    const rows = [
      { date: '2026-09-01', businessId: 'a', businessName: 'A', color: '#000', outflowCents: 1000, inflowCents: 0 },
      { date: '2026-09-15', businessId: 'b', businessName: 'B', color: '#111', outflowCents: 500, inflowCents: 4000 },
      { date: '2026-10-01', businessId: 'a', businessName: 'A', color: '#000', outflowCents: 9999, inflowCents: 0 },
    ];
    const september = movementForWindow(rows, '2026-09-01', '2026-09-30');
    expect(september).toMatchObject({ outflowCents: 1500, inflowCents: 4000, netCents: 2500 });
    expect(september.outflowBusinessCents.map((row) => row.businessId)).toEqual(['a', 'b']);
    expect(september.inflowBusinessCents).toEqual([{ businessId: 'b', businessName: 'B', color: '#111', cents: 4000 }]);
  });

  it('folds breakdown rows by business, account and receipt status', () => {
    const result = summarizeBreakdownRows([
      { businessId: 'a', businessName: 'A', color: '#000', accountId: 'acct-1', receiptStatus: 'missing', rows: 3, spendCount: 2, spendCents: 3000 },
      { businessId: 'a', businessName: 'A', color: '#000', accountId: null, receiptStatus: 'matched', rows: 1, spendCount: 1, spendCents: 500 },
      { businessId: 'b', businessName: 'B', color: '#111', accountId: 'acct-2', receiptStatus: 'n/a', rows: 4, spendCount: 0, spendCents: 0 },
    ]);
    expect(result.rows).toBe(8);
    expect(result.spendCents).toBe(3500);
    expect(result.spendCount).toBe(3);
    expect(result.byBusiness).toEqual([{ key: 'a', label: 'A', color: '#000', cents: 3500, count: 3 }]);
    expect(result.byAccount.map((row) => row.key)).toEqual(['acct-1']);
    expect(result.byReceipt.map((row) => row.key)).toEqual(['missing', 'matched']);
  });
});
