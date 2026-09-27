import type { ReactNode } from 'react';
import type { BusinessReportRow } from '@/lib/reports';
import { fmtDeltaPct, fmtWholeCents } from '@/lib/format';
import { cn } from '@/lib/cn';

/**
 * By-business scorecard for the report period: in, out, net, net vs the prior period, and a
 * 12-month net sparkline. A grid table on wide screens, stacked cards on phones.
 */
export function BusinessTable({ rows, compareLabel }: { rows: BusinessReportRow[]; compareLabel: string }) {
  if (!rows.length) return <div className="py-6 text-center text-sm text-dim">No business activity in this period.</div>;
  const total = rows.length > 1
    ? rows.reduce((sum, row) => ({
      inflowCents: sum.inflowCents + row.inflowCents,
      outflowCents: sum.outflowCents + row.outflowCents,
      netCents: sum.netCents + row.netCents,
      previousNetCents: sum.previousNetCents + row.previousNetCents,
    }), { inflowCents: 0, outflowCents: 0, netCents: 0, previousNetCents: 0 })
    : null;
  const columns = 'md:grid md:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))_minmax(0,1.1fr)_96px] md:items-center md:gap-3';
  return (
    <div role="table" aria-label="Cash flow by business" className="text-sm">
      <div role="row" className={cn('hidden border-b border-ink2/10 pb-2 font-mono text-[10px] font-medium uppercase tracking-wider text-dim', columns)}>
        <span role="columnheader">Business</span>
        <span role="columnheader" className="text-right">In</span>
        <span role="columnheader" className="text-right">Out</span>
        <span role="columnheader" className="text-right">Net</span>
        <span role="columnheader" className="text-right">vs {compareLabel}</span>
        <span role="columnheader" className="text-right">12 months</span>
      </div>
      {rows.map((row) => (
        <div key={row.businessId} role="row" className={cn('grid grid-cols-2 gap-x-3 gap-y-1 border-b border-ink2/5 py-3 last:border-b-0', columns)}>
          <span role="cell" className="col-span-2 inline-flex min-w-0 items-center gap-2 md:col-span-1">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: row.color }} aria-hidden="true" />
            <span className="truncate font-bold text-ink">{row.businessName}</span>
          </span>
          <Cell label="In" className="text-sage-ink">{fmtWholeCents(row.inflowCents)}</Cell>
          <Cell label="Out">{fmtWholeCents(row.outflowCents)}</Cell>
          <Cell label="Net" className={cn('font-display font-bold', row.netCents < 0 ? 'text-coral-ink' : 'text-ink')}>
            {fmtWholeCents(row.netCents, { signed: true })}
          </Cell>
          <Cell label={`vs ${compareLabel}`} className={row.netDeltaCents === 0 ? 'text-dim' : row.netDeltaCents > 0 ? 'text-sage-ink' : 'text-coral-ink'}>
            {fmtWholeCents(row.netDeltaCents, { signed: true })}
            <span className="ml-1 text-[11px] opacity-80">{row.netDeltaPct == null ? '' : `(${fmtDeltaPct(row.netDeltaPct)})`}</span>
          </Cell>
          <span role="cell" className="col-span-2 flex h-8 items-center md:col-span-1 md:justify-end">
            <MiniSpark values={row.trend} color={row.color} label={`${row.businessName} monthly net, last 12 months`} />
          </span>
        </div>
      ))}
      {total && (
        <div role="row" className={cn('grid grid-cols-2 gap-x-3 gap-y-1 border-t border-ink2/15 pt-3 font-bold', columns)}>
          <span role="cell" className="col-span-2 text-ink md:col-span-1">All businesses</span>
          <Cell label="In" className="text-sage-ink">{fmtWholeCents(total.inflowCents)}</Cell>
          <Cell label="Out">{fmtWholeCents(total.outflowCents)}</Cell>
          <Cell label="Net" className={cn('font-display', total.netCents < 0 ? 'text-coral-ink' : 'text-ink')}>
            {fmtWholeCents(total.netCents, { signed: true })}
          </Cell>
          <Cell label={`vs ${compareLabel}`} className={total.netCents - total.previousNetCents >= 0 ? 'text-sage-ink' : 'text-coral-ink'}>
            {fmtWholeCents(total.netCents - total.previousNetCents, { signed: true })}
          </Cell>
          <span className="hidden md:block" />
        </div>
      )}
    </div>
  );
}

function Cell({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <span role="cell" className="flex items-baseline justify-between gap-2 md:block md:text-right">
      <span className="font-mono text-[10px] uppercase tracking-wider text-dim md:hidden">{label}</span>
      <span className={cn('tabular-nums', className)}>{children}</span>
    </span>
  );
}

/** Tiny net-per-month line with a zero baseline; hidden from screen readers except its label. */
function MiniSpark({ values, color, label }: { values: number[]; color: string; label: string }) {
  if (values.length < 2 || values.every((value) => value === 0)) {
    return <span className="text-xs text-dim">—</span>;
  }
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const range = max - min || 1;
  const point = (value: number, index: number) => `${(index / (values.length - 1)) * 100},${100 - ((value - min) / range) * 100}`;
  const zeroY = 100 - ((0 - min) / range) * 100;
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-8 w-24" role="img" aria-label={label}>
      <line x1="0" x2="100" y1={zeroY} y2={zeroY} className="stroke-ink2/20" vectorEffect="non-scaling-stroke" />
      <polyline
        points={values.map(point).join(' ')}
        fill="none"
        stroke={color}
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
