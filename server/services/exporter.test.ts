import { describe, expect, it } from 'vitest';
import { exportDateRangeError, isIsoDate } from './exporter.js';

describe('isIsoDate', () => {
  it('accepts real YYYY-MM-DD dates', () => {
    expect(isIsoDate('2026-01-31')).toBe(true);
    expect(isIsoDate('2024-02-29')).toBe(true);
  });

  it('rejects other formats and impossible dates', () => {
    for (const value of ['2026-1-31', '01/31/2026', '2026-02-30', '2025-02-29', '2026-13-01', '2026-01-31T00:00:00Z', '', "2026-01-01' OR 1=1"]) {
      expect(isIsoDate(value)).toBe(false);
    }
  });
});

describe('exportDateRangeError', () => {
  it('accepts ordered ranges, including a single day', () => {
    expect(exportDateRangeError('2026-01-01', '2026-03-31')).toBeNull();
    expect(exportDateRangeError('2026-01-01', '2026-01-01')).toBeNull();
  });

  it('rejects invalid or reversed ranges', () => {
    expect(exportDateRangeError('2026-1-1', '2026-03-31')).toMatch(/dateFrom/);
    expect(exportDateRangeError('2026-01-01', 'soon')).toMatch(/dateTo/);
    expect(exportDateRangeError('2026-04-01', '2026-03-31')).toMatch(/on or before/);
  });
});
