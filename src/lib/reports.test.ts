import { describe, expect, it } from 'vitest';
import type { CashFlowPeriod } from '@/types/domain';
import { businessReportRows, reportPresets, sumBusinessBreakdown } from './reports';

function period(label: string, rows: Array<[string, number, number]>): CashFlowPeriod {
  const breakdown = rows.map(([id, inflow, outflow]) => ({
    businessId: id,
    businessName: id.toUpperCase(),
    color: '#000',
    inflowCents: inflow,
    outflowCents: outflow,
    transferCents: 0,
    netCents: inflow - outflow,
    previousNetCents: 0,
  }));
  const sum = (key: 'inflowCents' | 'outflowCents' | 'netCents') => breakdown.reduce((total, row) => total + row[key], 0);
  return {
    label,
    from: '2026-01-01',
    to: '2026-01-31',
    inflowCents: sum('inflowCents'),
    outflowCents: sum('outflowCents'),
    transferCents: 0,
    netCents: sum('netCents'),
    previousInflowCents: 0,
    previousOutflowCents: 0,
    previousTransferCents: 0,
    previousNetCents: 0,
    netDeltaCents: 0,
    netDeltaPct: 0,
    businessBreakdown: breakdown,
  };
}

describe('sumBusinessBreakdown', () => {
  it('adds each business across periods', () => {
    const totals = sumBusinessBreakdown([period('Jan', [['a', 100, 40]]), period('Feb', [['a', 50, 10], ['b', 0, 30]])]);
    expect(totals.get('a')).toMatchObject({ inflowCents: 150, outflowCents: 50, netCents: 100 });
    expect(totals.get('b')).toMatchObject({ inflowCents: 0, outflowCents: 30, netCents: -30 });
  });
});

describe('businessReportRows', () => {
  it('compares with the prior period, keeps quiet businesses, and sorts by net', () => {
    const rows = businessReportRows({
      current: [period('Sep', [['a', 1000, 400]])],
      prior: [period('Aug', [['a', 800, 400], ['b', 0, 100]])],
      trend: [period('Aug', [['a', 800, 400], ['b', 0, 100]]), period('Sep', [['a', 1000, 400]])],
    });
    expect(rows.map((row) => row.businessId)).toEqual(['a', 'b']);
    expect(rows[0]).toMatchObject({ netCents: 600, previousNetCents: 400, netDeltaCents: 200, netDeltaPct: 50, trend: [400, 600] });
    expect(rows[1]).toMatchObject({ netCents: 0, previousNetCents: -100, netDeltaCents: 100, trend: [-100, 0] });
  });
});

describe('reportPresets', () => {
  it('builds month-aligned periods from today', () => {
    const presets = Object.fromEntries(reportPresets('2026-03-15').map((preset) => [preset.id, [preset.from, preset.to]]));
    expect(presets['last-month']).toEqual(['2026-02-01', '2026-02-28']);
    expect(presets['this-month']).toEqual(['2026-03-01', '2026-03-15']);
    expect(presets['last-3']).toEqual(['2026-01-01', '2026-03-15']);
    expect(presets.ytd).toEqual(['2026-01-01', '2026-03-15']);
    expect(presets['last-12']).toEqual(['2025-04-01', '2026-03-15']);
  });
});
