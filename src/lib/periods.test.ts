import { describe, expect, it } from 'vitest';
import {
  alignedPrior,
  buildSpendPace,
  buildTimeWindow,
  cumulative,
  daysInRange,
  densifyDaily,
  elapsedEnd,
  pctChange,
  priorPeriod,
} from './periods';

describe('priorPeriod', () => {
  it('compares a full month with the full month before', () => {
    expect(priorPeriod('2026-09-01', '2026-09-30')).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(priorPeriod('2026-03-01', '2026-03-31')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });

  it('compares month-to-date with the same days of last month', () => {
    expect(priorPeriod('2026-09-01', '2026-09-27')).toEqual({ from: '2026-08-01', to: '2026-08-27' });
    // Mar 1–31 is a full month; Mar 1–30 clamps into February.
    expect(priorPeriod('2026-03-01', '2026-03-30')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });

  it('shifts multi-month windows by the months they span', () => {
    expect(priorPeriod('2026-07-01', '2026-09-30')).toEqual({ from: '2026-04-01', to: '2026-06-30' });
    expect(priorPeriod('2025-10-01', '2026-09-30')).toEqual({ from: '2024-10-01', to: '2025-09-30' });
  });

  it('uses the equal-length window before for ranges not starting on the 1st', () => {
    expect(priorPeriod('2026-09-10', '2026-09-19')).toEqual({ from: '2026-08-31', to: '2026-09-09' });
  });
});

describe('small helpers', () => {
  it('counts days inclusively', () => {
    expect(daysInRange('2026-09-01', '2026-09-30')).toBe(30);
    expect(daysInRange('2026-09-01', '2026-09-01')).toBe(1);
  });

  it('caps the elapsed end at today and returns null for future windows', () => {
    expect(elapsedEnd('2026-09-01', '2026-09-30', '2026-09-27')).toBe('2026-09-27');
    expect(elapsedEnd('2026-08-01', '2026-08-31', '2026-09-27')).toBe('2026-08-31');
    expect(elapsedEnd('2026-10-01', '2026-10-31', '2026-09-27')).toBeNull();
  });

  it('builds running totals and percent changes', () => {
    expect(cumulative([1, 2, 3, 0])).toEqual([1, 3, 6, 6]);
    expect(cumulative([])).toEqual([]);
    expect(pctChange(150, 100)).toBe(50);
    expect(pctChange(-50, -100)).toBe(50);
    expect(pctChange(10, 0)).toBeNull();
  });

  it('fills missing days with zeros and merges duplicate dates', () => {
    const rows = [
      { date: '2026-09-02', outflowCents: 100, inflowCents: 0 },
      { date: '2026-09-02', outflowCents: 50, inflowCents: 10 },
    ];
    expect(densifyDaily(rows, '2026-09-01', '2026-09-03')).toEqual([
      { date: '2026-09-01', outflowCents: 0, inflowCents: 0 },
      { date: '2026-09-02', outflowCents: 150, inflowCents: 10 },
      { date: '2026-09-03', outflowCents: 0, inflowCents: 0 },
    ]);
  });

  it('builds the Home windows for each preset', () => {
    expect(buildTimeWindow('2026-09', 'month')).toMatchObject({ from: '2026-09-01', to: '2026-09-30' });
    expect(buildTimeWindow('2026-09', 'last3')).toMatchObject({ from: '2026-07-01', to: '2026-09-30' });
    expect(buildTimeWindow('2026-09', 'ytd')).toMatchObject({ from: '2026-01-01', to: '2026-09-30' });
  });

  it('aligns the prior window to the elapsed days', () => {
    expect(alignedPrior({ from: '2026-08-01', to: '2026-08-31' }, 27)).toEqual({ from: '2026-08-01', to: '2026-08-27' });
    expect(alignedPrior({ from: '2026-02-01', to: '2026-02-28' }, 31)).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(alignedPrior({ from: '2026-08-01', to: '2026-08-31' }, 0)).toBeNull();
  });
});

describe('buildSpendPace', () => {
  const rows = [
    { date: '2026-08-01', outflowCents: 1000, inflowCents: 5000 },
    { date: '2026-08-03', outflowCents: 500, inflowCents: 0 },
    { date: '2026-08-20', outflowCents: 4000, inflowCents: 0 },
    { date: '2026-09-01', outflowCents: 300, inflowCents: 0 },
    { date: '2026-09-02', outflowCents: 900, inflowCents: 2000 },
  ];

  it('compares month-to-date with last month at the same day', () => {
    const pace = buildSpendPace({
      window: { from: '2026-09-01', to: '2026-09-30' },
      prior: { from: '2026-08-01', to: '2026-08-31' },
      today: '2026-09-03',
      rows,
    });
    expect(pace.elapsedDays).toBe(3);
    expect(pace.current).toEqual([300, 1200, 1200]);
    expect(pace.previous).toHaveLength(31);
    expect(pace.previous.at(-1)).toBe(5500);
    expect(pace.spend).toEqual({ currentCents: 1200, previousCents: 1500, deltaPct: -20 });
    expect(pace.income).toEqual({ currentCents: 2000, previousCents: 5000, deltaPct: -60 });
    expect(pace.net.currentCents).toBe(800);
    expect(pace.net.previousCents).toBe(3500);
  });

  it('is empty (not a flat line) for a window that has not started', () => {
    const pace = buildSpendPace({
      window: { from: '2026-10-01', to: '2026-10-31' },
      prior: { from: '2026-09-01', to: '2026-09-30' },
      today: '2026-09-03',
      rows,
    });
    expect(pace.elapsedDays).toBe(0);
    expect(pace.current).toEqual([]);
    expect(pace.spend.deltaPct).toBeNull();
  });
});
