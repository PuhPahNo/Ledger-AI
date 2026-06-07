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
