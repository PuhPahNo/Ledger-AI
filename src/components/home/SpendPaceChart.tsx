import { useMemo, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { LineChart as LineChartIcon } from 'lucide-react';
import type { SpendPace } from '@/lib/periods';
import { parseLocalIsoDate, shiftIsoDays } from '@/lib/dates';
import { fmtCompactCents, fmtWholeCents } from '@/lib/format';
import { useElementWidth } from '@/hooks/useElementWidth';
import { ChartTooltip, useChartTooltip } from '@/components/ui/chart-tooltip';
import { EmptyState } from '@/components/ui/empty-state';

const PAD = { top: 12, right: 12, bottom: 24, left: 52 };
const CURRENT_STROKE = 'hsl(var(--chart-1))';
const PREVIOUS_STROKE = 'hsl(var(--chart-muted) / 0.4)';

interface Props {
  pace: SpendPace;
  /** First day and length of the current window (the x axis spans the whole window). */
  windowFrom: string;
  windowDays: number;
  currentLabel: string;
  previousLabel: string;
  height?: number;
}

interface HoverData {
  index: number;
  currentDate?: string;
  previousDate?: string;
  current?: number;
  previous?: number;
}

/**
 * Cumulative spend so far this period (solid) against the prior period's cumulative line
 * (dashed). Replaces the spiky daily bars: the gap between the lines is the answer to
 * "am I spending faster than last month?".
 */
export function SpendPaceChart({ pace, windowFrom, windowDays, currentLabel, previousLabel, height = 220 }: Props) {
  const [measureRef, width] = useElementWidth<HTMLDivElement>();
  const { tip, containerRef, show, hide } = useChartTooltip<HoverData>();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const spentSoFar = pace.current.at(-1) ?? 0;
  const count = Math.max(windowDays, pace.previous.length, 2);
  const maxY = niceMax(Math.max(spentSoFar, pace.previous.at(-1) ?? 0, 1));
  const plotWidth = Math.max(width - PAD.left - PAD.right, 1);
  const plotHeight = height - PAD.top - PAD.bottom;
  const x = (index: number) => PAD.left + (index / (count - 1)) * plotWidth;
  const y = (cents: number) => PAD.top + plotHeight - (cents / maxY) * plotHeight;

  const paths = useMemo(() => ({
    current: linePath(pace.current, x, y),
    previous: linePath(pace.previous, x, y),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [pace, width, height, maxY, count]);

  if (pace.elapsedDays === 0 || spentSoFar === 0) {
    const priorTotal = pace.previous.at(-1) ?? 0;
    return (
      <EmptyState
        icon={<LineChartIcon className="h-5 w-5" />}
        title="No spend recorded yet in this period"
        description={priorTotal > 0 ? `${previousLabel} finished at ${fmtWholeCents(priorTotal)}.` : undefined}
        className="py-10"
      />
    );
  }

  const hoverFor = (index: number): HoverData => ({
    index,
    currentDate: index < pace.current.length ? shiftIsoDays(windowFrom, index) : undefined,
    current: pace.current[index],
    previousDate: pace.previousDates[index],
    previous: pace.previous[index],
  });

  const indexFromPointer = (event: PointerEvent<SVGRectElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / Math.max(rect.width, 1);
    return Math.min(count - 1, Math.max(0, Math.round(ratio * (count - 1))));
  };
  const onPointer = (event: PointerEvent<SVGRectElement>) => {
    const index = indexFromPointer(event);
    setHoverIndex(index);
    show(hoverFor(index), event);
  };
  const onKey = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const start = hoverIndex ?? pace.current.length - 1;
    setHoverIndex(Math.min(count - 1, Math.max(0, start + (event.key === 'ArrowRight' ? 1 : -1))));
  };

  const readout = hoverFor(hoverIndex ?? pace.current.length - 1);
  const summary = `${currentLabel}: ${fmtWholeCents(spentSoFar)} spent over ${pace.elapsedDays} day${pace.elapsedDays === 1 ? '' : 's'}; `
    + `${previousLabel} at the same point: ${fmtWholeCents(pace.spend.previousCents)}.`;
  const ticks = [0, 0.5, 1];
  const xLabelIndexes = [0, Math.floor((windowDays - 1) / 2), windowDays - 1];

  return (
    <div ref={containerRef} className="grid gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" aria-live="polite">
        <Legend color={CURRENT_STROKE} label={currentLabel} value={readout.current} date={readout.currentDate} />
        <Legend color={PREVIOUS_STROKE} dashed label={previousLabel} value={readout.previous} date={readout.previousDate} />
      </div>
      <div ref={measureRef} className="w-full touch-pan-y" style={{ height }} onPointerLeave={() => { hide(); setHoverIndex(null); }}>
        {width > 0 && (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={summary}
            tabIndex={0}
            onKeyDown={onKey}
            onBlur={() => setHoverIndex(null)}
            className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20"
          >
            <title>{summary}</title>
            {ticks.map((fraction) => {
              const tickY = PAD.top + plotHeight - fraction * plotHeight;
              return (
                <g key={fraction}>
                  <line x1={PAD.left} x2={width - PAD.right} y1={tickY} y2={tickY} className={fraction === 0 ? 'stroke-ink2/25' : 'stroke-ink2/10'} />
                  <text x={PAD.left - 8} y={tickY + 3} textAnchor="end" className="fill-dim font-mono text-[10px]">
                    {fmtCompactCents(maxY * fraction)}
                  </text>
                </g>
              );
            })}
            {xLabelIndexes.map((index, position) => (
              <text
                key={`${index}-${position}`}
                x={x(index)}
                y={height - 6}
                textAnchor={position === 0 ? 'start' : position === 2 ? 'end' : 'middle'}
                className="fill-dim font-mono text-[10px] uppercase"
              >
                {shortDate(shiftIsoDays(windowFrom, index))}
              </text>
            ))}

            <path d={paths.previous} fill="none" style={{ stroke: PREVIOUS_STROKE }} strokeWidth={2} strokeDasharray="5 4" strokeLinejoin="round" />
            <path d={paths.current} fill="none" style={{ stroke: CURRENT_STROKE }} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
            <circle cx={x(pace.current.length - 1)} cy={y(spentSoFar)} r={4} style={{ fill: CURRENT_STROKE }} className="stroke-paper" strokeWidth={2} />

            {hoverIndex != null && (
              <g>
                <line x1={x(hoverIndex)} x2={x(hoverIndex)} y1={PAD.top} y2={PAD.top + plotHeight} className="stroke-ink2/25" />
                {pace.previous[hoverIndex] != null && (
                  <circle cx={x(hoverIndex)} cy={y(pace.previous[hoverIndex])} r={3.5} style={{ fill: 'hsl(var(--chart-muted))' }} className="stroke-paper" strokeWidth={2} />
                )}
                {pace.current[hoverIndex] != null && (
                  <circle cx={x(hoverIndex)} cy={y(pace.current[hoverIndex])} r={4} style={{ fill: CURRENT_STROKE }} className="stroke-paper" strokeWidth={2} />
                )}
              </g>
            )}

            <rect
              x={PAD.left}
              y={PAD.top}
              width={plotWidth}
              height={plotHeight}
              fill="transparent"
              onPointerDown={onPointer}
              onPointerMove={onPointer}
            />
          </svg>
        )}
      </div>
      <ChartTooltip open={tip.open} x={tip.x} y={tip.y}>
        {tip.data && (
          <div className="grid gap-0.5">
            <div className="font-mono text-[10px] uppercase tracking-wider opacity-70">Day {tip.data.index + 1}</div>
            {tip.data.current != null && (
              <div><span className="opacity-70">{currentLabel} · {shortDate(tip.data.currentDate!)}</span> <b className="tabular-nums">{fmtWholeCents(tip.data.current)}</b></div>
            )}
            {tip.data.previous != null && (
              <div><span className="opacity-70">{previousLabel} · {shortDate(tip.data.previousDate!)}</span> <b className="tabular-nums">{fmtWholeCents(tip.data.previous)}</b></div>
            )}
          </div>
        )}
      </ChartTooltip>
    </div>
  );
}

function Legend({ color, label, value, date, dashed }: { color: string; label: string; value?: number; date?: string; dashed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg width="16" height="6" aria-hidden="true">
        <line x1="0" x2="16" y1="3" y2="3" style={{ stroke: color }} strokeWidth={dashed ? 2 : 2.5} strokeDasharray={dashed ? '4 3' : undefined} />
      </svg>
      <span className="font-bold text-ink">{label}</span>
      {value != null && (
        <span className="tabular-nums text-dim">
          {fmtWholeCents(value)}{date ? ` by ${shortDate(date)}` : ''}
        </span>
      )}
    </span>
  );
}

function linePath(values: number[], x: (index: number) => number, y: (value: number) => number): string {
  return values.map((value, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(' ');
}

/** Round the axis max up to 1 / 2 / 2.5 / 5 × 10ⁿ so gridline labels are tidy. */
function niceMax(value: number): number {
  const exponent = 10 ** Math.floor(Math.log10(value));
  const fraction = value / exponent;
  const step = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return step * exponent;
}

function shortDate(iso: string): string {
  return parseLocalIsoDate(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
