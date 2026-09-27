import { useState } from 'react';
import type { PointerEvent } from 'react';
import { BarChart3 } from 'lucide-react';
import type { CashFlowPeriod } from '@/types/domain';
import { fmtCompactCents, fmtWholeCents } from '@/lib/format';
import { useElementWidth } from '@/hooks/useElementWidth';
import { ChartTooltip, useChartTooltip } from '@/components/ui/chart-tooltip';
import { EmptyState } from '@/components/ui/empty-state';

export type CashFlowChartMode = 'net' | 'flow';

const PAD = { top: 10, right: 8, bottom: 24, left: 52 };
const POSITIVE = 'hsl(var(--chart-3))';
const NEGATIVE = 'hsl(var(--chart-1))';

interface Props {
  periods: CashFlowPeriod[];
  mode: CashFlowChartMode;
  /** The selected report period; months outside it are dimmed. */
  highlight: { from: string; to: string };
  height?: number;
}

/**
 * Monthly cash flow over the trailing year. "Net" (default) is one diverging bar per month;
 * "In vs out" pairs the two. One chart with a toggle, instead of two charts.
 */
export function NetCashFlowChart({ periods, mode, highlight, height = 240 }: Props) {
  const [measureRef, width] = useElementWidth<HTMLDivElement>();
  const { tip, containerRef, show, hide } = useChartTooltip<CashFlowPeriod>();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const hasData = periods.some((period) => period.inflowCents !== 0 || period.outflowCents !== 0);
  if (!periods.length || !hasData) {
    return <EmptyState icon={<BarChart3 className="h-5 w-5" />} title="No cash movement in this range" className="py-12" />;
  }

  const values = mode === 'net'
    ? periods.map((period) => period.netCents)
    : periods.flatMap((period) => [period.inflowCents, period.outflowCents]);
  const top = Math.max(0, ...values);
  const bottom = mode === 'net' ? Math.min(0, ...values) : 0;
  const span = top - bottom || 1;
  const plotWidth = Math.max(width - PAD.left - PAD.right, 1);
  const plotHeight = height - PAD.top - PAD.bottom;
  const y = (cents: number) => PAD.top + ((top - cents) / span) * plotHeight;
  const band = plotWidth / periods.length;
  const barWidth = Math.max(4, Math.min(mode === 'net' ? 28 : 14, band * (mode === 'net' ? 0.6 : 0.34)));
  const labelEvery = band < 30 ? 3 : band < 44 ? 2 : 1;
  const inPeriod = (period: CashFlowPeriod) => period.to >= highlight.from && period.from <= highlight.to;
  const ticks = mode === 'net' && bottom < 0 ? [top, 0, bottom] : [top, top / 2, 0];

  const total = periods.reduce((sum, period) => sum + period.netCents, 0);
  const summary = `${mode === 'net' ? 'Net cash flow' : 'Money in and out'} by month, ${periods[0].label} to ${periods.at(-1)!.label}. `
    + `Net over the range: ${fmtWholeCents(total, { signed: true })}.`;

  const onPointer = (event: PointerEvent<SVGRectElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const index = Math.min(periods.length - 1, Math.max(0, Math.floor(((event.clientX - rect.left) / Math.max(rect.width, 1)) * periods.length)));
    setHoverIndex(index);
    show(periods[index], event);
  };

  return (
    <div ref={containerRef}>
      <div ref={measureRef} className="w-full touch-pan-y" style={{ height }} onPointerLeave={() => { hide(); setHoverIndex(null); }}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label={summary}>
            <title>{summary}</title>
            {ticks.map((value, index) => (
              <g key={`${value}-${index}`}>
                <line x1={PAD.left} x2={width - PAD.right} y1={y(value)} y2={y(value)} className={value === 0 ? 'stroke-ink2/30' : 'stroke-ink2/10'} />
                <text x={PAD.left - 8} y={y(value) + 3} textAnchor="end" className="fill-dim font-mono text-[10px]">
                  {fmtCompactCents(value, { signed: mode === 'net' && value !== 0 })}
                </text>
              </g>
            ))}
            {periods.map((period, index) => {
              const center = PAD.left + band * index + band / 2;
              const opacity = inPeriod(period) ? 1 : 0.35;
              const hovered = hoverIndex === index;
              return (
                <g key={period.label} opacity={opacity}>
                  {hovered && <rect x={PAD.left + band * index} y={PAD.top} width={band} height={plotHeight} className="fill-ink/5" />}
                  {mode === 'net' ? (
                    <rect
                      x={center - barWidth / 2}
                      y={Math.min(y(period.netCents), y(0))}
                      width={barWidth}
                      height={Math.max(1, Math.abs(y(period.netCents) - y(0)))}
                      rx={3}
                      style={{ fill: period.netCents >= 0 ? POSITIVE : NEGATIVE }}
                    />
                  ) : (
                    <>
                      <rect x={center - barWidth - 1} y={y(period.inflowCents)} width={barWidth} height={Math.max(1, y(0) - y(period.inflowCents))} rx={2} style={{ fill: POSITIVE }} />
                      <rect x={center + 1} y={y(period.outflowCents)} width={barWidth} height={Math.max(1, y(0) - y(period.outflowCents))} rx={2} style={{ fill: NEGATIVE }} />
                    </>
                  )}
                  {index % labelEvery === 0 && (
                    <text x={center} y={height - 6} textAnchor="middle" className="fill-dim font-mono text-[10px] uppercase">
                      {period.label.split(' ')[0]}
                    </text>
                  )}
                </g>
              );
            })}
            <rect x={PAD.left} y={PAD.top} width={plotWidth} height={plotHeight} fill="transparent" onPointerDown={onPointer} onPointerMove={onPointer} />
          </svg>
        )}
      </div>
      <ChartTooltip open={tip.open} x={tip.x} y={tip.y}>
        {tip.data && (
          <div className="grid gap-0.5">
            <div className="font-mono text-[10px] uppercase tracking-wider opacity-70">{tip.data.label}</div>
            <div className="grid grid-cols-[auto_auto] gap-x-3 tabular-nums">
              <span className="opacity-70">In</span><span className="text-right font-bold">{fmtWholeCents(tip.data.inflowCents)}</span>
              <span className="opacity-70">Out</span><span className="text-right font-bold">{fmtWholeCents(tip.data.outflowCents)}</span>
              <span className="opacity-70">Net</span><span className="text-right font-bold">{fmtWholeCents(tip.data.netCents, { signed: true })}</span>
            </div>
          </div>
        )}
      </ChartTooltip>
    </div>
  );
}
