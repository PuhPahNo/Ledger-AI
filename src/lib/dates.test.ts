import { describe, expect, it } from 'vitest';
import {
  monthBounds,
  monthsSpanned,
  shiftIsoDays,
  shiftIsoMonths,
  shiftMonthKey,
  singleMonthOfRange,
  startOfMonthIso,
  toLocalIsoDate,
  toLocalMonthKey,
  todayIso,
  trailingMonthsFrom,
} from './dates';

describe('local date helpers', () => {
  it('formats from local calendar fields, not UTC', () => {
    // 11:30pm local on Sep 30 is already Oct 1 in UTC for every US timezone.
    const lateEvening = new Date(2026, 8, 30, 23, 30);
    expect(toLocalIsoDate(lateEvening)).toBe('2026-09-30');
    expect(toLocalMonthKey(lateEvening)).toBe('2026-09');
    expect(todayIso(lateEvening)).toBe('2026-09-30');
    // Local midnight on the 1st must not serialize as the previous month's last day.
    expect(startOfMonthIso(new Date(2026, 9, 1, 0, 5))).toBe('2026-10-01');
  });

  it('computes month bounds including leap years', () => {
    expect(monthBounds('2026-09')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(monthBounds('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(monthBounds('2026-12')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });

  it('shifts days, months and month keys across year boundaries', () => {
    expect(shiftIsoDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftIsoMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(shiftIsoMonths('2026-01-15', -12)).toBe('2025-01-15');
    expect(shiftMonthKey('2026-01', -1)).toBe('2025-12');
    expect(shiftMonthKey('2026-12', 1)).toBe('2027-01');
  });

  it('builds trailing windows and detects single-month ranges', () => {
    expect(trailingMonthsFrom('2026-09-27', 12)).toBe('2025-10-01');
    expect(monthsSpanned('2025-10-01', '2026-09-27')).toBe(12);
    expect(singleMonthOfRange('2026-09-01', '2026-09-27')).toBe('2026-09');
    expect(singleMonthOfRange('2026-08-15', '2026-09-27')).toBeNull();
  });
});
