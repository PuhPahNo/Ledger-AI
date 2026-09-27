import { useEffect, useMemo, useState } from 'react';
import { getTagTrends, listTags } from '@/api';
import type { TagTrendSeries } from '@/types/domain';
import { cn } from '@/lib/cn';
import { fmt$, fmtCompactCents } from '@/lib/format';
import { useElementWidth } from '@/hooks/useElementWidth';
import { Card } from '@/components/ui/card';
import { ChartTooltip, useChartTooltip } from '@/components/ui/chart-tooltip';

const MAX_SERIES = 10;
const DEFAULT_SERIES = 5;

interface Props {
  /** Trend window (the same trailing year as the cash-flow chart). */
  from: string;
  to: string;
  /** The report period: the card only appears when a tag has spend inside it. */
  period: { from: string; to: string };
}

/**
 * Monthly outflow per custom tag (e.g. "AI"). Renders nothing unless at least one tag has
 * spend in the report period — no empty card for workspaces that don't use tags.
 * The tag chips are both the legend and the series toggles.
 */
export function TagTrendsCard({ from, to, period }: Props) {
  const [series, setSeries] = useState<TagTrendSeries[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  useEffect(() => {
    // Overlapping range changes fire several requests; only the latest may write state.
    let cancelled = false;
    listTags()
      .then((tags) => {
        const active = tags.filter((tag) => tag.active).slice(0, 50);
        if (!active.length) return [];
        return getTagTrends({ tagIds: active.map((tag) => tag.id), from, to });
      })
      .then((rows) => {
        if (cancelled) return;
        setSeries(rows);
        const periodMonths = (month: string) => month >= period.from.slice(0, 7) && month <= period.to.slice(0, 7);
        const ranked = rows
          .map((row) => ({ id: row.tagId, cents: row.points.filter((point) => periodMonths(point.month)).reduce((sum, point) => sum + point.totalCents, 0) }))
          .filter((row) => row.cents > 0)
          .sort((a, b) => b.cents - a.cents);
        setSelectedIds(ranked.slice(0, DEFAULT_SERIES).map((row) => row.id));
      })
      .catch(() => !cancelled && setSeries([]));
    return () => {
      cancelled = true;
    };
  }, [from, to, period.from, period.to]);

  const withSpend = useMemo(
    () => (series ?? []).filter((row) => row.points.some((point) => point.totalCents > 0)),
    [series],
  );
  // Nothing tagged in the period (or tags aren't used): omit the card entirely.
  if (!series || selectedIds.length === 0) return null;

  const toggleTag = (tagId: string) => {
    setSelectedIds((ids) => {
      if (ids.includes(tagId)) return ids.filter((id) => id !== tagId);
      if (ids.length >= MAX_SERIES) return ids;
      return [...ids, tagId];
    });
  };
  const visible = withSpend.filter((row) => selectedIds.includes(row.tagId));

  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">Tags</div>
          <h2 className="font-display text-lg font-bold text-ink">Tagged spend by month</h2>
        </div>
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Tags to chart">
          {withSpend.map((row) => {
            const active = selectedIds.includes(row.tagId);
            return (
              <button
                key={row.tagId}
                type="button"
                aria-pressed={active}
                onClick={() => toggleTag(row.tagId)}
                className={cn(
                  'inline-flex min-h-10 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-bold transition-colors sm:min-h-0',
                  active ? 'border-inverse bg-inverse text-inverse-foreground' : 'border-ink2/20 bg-cream/70 text-ink hover:border-ink2/40',
                )}
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: row.color }} />
                {row.name}
              </button>
            );
          })}
        </div>
      </div>
      {visible.length === 0 ? (
        <div className="flex h-[200px] items-center justify-center text-sm text-dim">Pick a tag above to chart its spend.</div>
      ) : (
        <TagTrendChart series={visible} />
      )}
    </Card>
  );
}

const PAD = { top: 10, right: 16, bottom: 22, left: 48 };
const CHART_HEIGHT = 240;

interface HoverData {
  month: string;
  values: Array<{ name: string; color: string; totalCents: number; count: number }>;
}

function TagTrendChart({ series }: { series: TagTrendSeries[] }) {
  const { tip, containerRef, show, hide } = useChartTooltip<HoverData>();
  const [setMeasureNode, width] = useElementWidth<HTMLDivElement>();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const months = series[0]?.points.map((point) => point.month) ?? [];
  const maxCents = Math.max(...series.flatMap((row) => row.points.map((point) => point.totalCents)), 1);

  const plotWidth = Math.max(width - PAD.left - PAD.right, 1);
  const plotHeight = CHART_HEIGHT - PAD.top - PAD.bottom;
  const xFor = (index: number) => (
    PAD.left + (months.length > 1 ? (index / (months.length - 1)) * plotWidth : plotWidth / 2)
  );
  const yFor = (cents: number) => PAD.top + plotHeight - (cents / maxCents) * plotHeight;

  const hoverData = useMemo(() => months.map((month, index): HoverData => ({
    month,
    values: series
      .map((row) => ({
        name: row.name,
        color: row.color,
        totalCents: row.points[index]?.totalCents ?? 0,
        count: row.points[index]?.count ?? 0,
      }))
      .sort((a, b) => b.totalCents - a.totalCents),
  })), [months, series]);

  if (months.length === 0) {
    return (
      <div className="flex h-[220px] items-center justify-center text-sm text-dim">
        No tagged spend in this range yet.
      </div>
    );
  }

  return (
    <div ref={containerRef} onMouseLeave={() => { hide(); setHoverIndex(null); }}>
      <div ref={setMeasureNode} className="w-full">
        {width > 0 && (
          <svg width={width} height={CHART_HEIGHT} role="img" aria-label="Monthly spend per tag">
            {/* Recessive gridlines + y labels */}
            {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
              const y = PAD.top + plotHeight - fraction * plotHeight;
              return (
                <g key={fraction}>
                  <line
                    x1={PAD.left}
                    x2={width - PAD.right}
                    y1={y}
                    y2={y}
                    className={fraction === 0 ? 'stroke-ink2/20' : 'stroke-ink2/5'}
                  />
                  <text
                    x={PAD.left - 8}
                    y={y + 3}
                    textAnchor="end"
                    className="fill-dim font-mono text-[10px]"
                  >
                    {fmtCompactCents(Math.round(maxCents * fraction))}
                  </text>
                </g>
              );
            })}

            {/* X labels — thinned when the range is long so they never collide */}
            {months.map((month, index) => {
              const step = Math.ceil(months.length / 12);
              if (index % step !== 0) return null;
              return (
                <text
                  key={month}
                  x={xFor(index)}
                  y={CHART_HEIGHT - 6}
                  textAnchor="middle"
                  className="fill-dim font-mono text-[10px] font-medium uppercase tracking-wider"
                >
                  {monthShort(month)}
                </text>
              );
            })}

            {/* Hover column indicator */}
            {hoverIndex != null && (
              <line
                x1={xFor(hoverIndex)}
                x2={xFor(hoverIndex)}
                y1={PAD.top}
                y2={PAD.top + plotHeight}
                className="stroke-ink2/20"
              />
            )}

            {/* Series lines + points */}
            {series.map((row) => {
              const path = row.points
                .map((point, index) => `${index === 0 ? 'M' : 'L'}${xFor(index)},${yFor(point.totalCents)}`)
                .join(' ');
              return (
                <g key={row.tagId}>
                  <path d={path} fill="none" stroke={row.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                  {row.points.map((point, index) => (
                    <circle
                      key={point.month}
                      cx={xFor(index)}
                      cy={yFor(point.totalCents)}
                      r={hoverIndex === index ? 4 : 2.5}
                      fill={row.color}
                      className="stroke-paper"
                      strokeWidth={2}
                    />
                  ))}
                </g>
              );
            })}

            {/* Full-height hover targets, one per month */}
            {months.map((month, index) => {
              const left = index === 0 ? PAD.left : (xFor(index - 1) + xFor(index)) / 2;
              const right = index === months.length - 1 ? width - PAD.right : (xFor(index) + xFor(index + 1)) / 2;
              return (
                <rect
                  key={month}
                  x={left}
                  y={PAD.top}
                  width={Math.max(right - left, 8)}
                  height={plotHeight}
                  fill="transparent"
                  onMouseEnter={(event) => { setHoverIndex(index); show(hoverData[index], event); }}
                  onMouseMove={(event) => show(hoverData[index], event)}
                />
              );
            })}
          </svg>
        )}
      </div>

      <ChartTooltip open={tip.open} x={tip.x} y={tip.y}>
        {tip.data && (
          <div className="grid gap-1">
            <div className="font-mono text-[10px] font-medium uppercase tracking-wider opacity-70">
              {monthLong(tip.data.month)}
            </div>
            {tip.data.values.map((value) => (
              <div key={value.name} className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: value.color }} />
                <span className="flex-1 pr-3 font-bold">{value.name}</span>
                <span className="tabular-nums">
                  {fmt$(value.totalCents / 100)}
                  <span className="ml-1 opacity-70">· {value.count} txn{value.count === 1 ? '' : 's'}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </ChartTooltip>
    </div>
  );
}

function monthShort(month: string): string {
  const date = new Date(`${month}-01T00:00:00`);
  if (Number.isNaN(date.getTime())) return month;
  // A 12-month range spans two calendar years, so January carries the year.
  if (date.getMonth() === 0) {
    return `${date.toLocaleDateString(undefined, { month: 'short' })} '${String(date.getFullYear()).slice(2)}`;
  }
  return date.toLocaleDateString(undefined, { month: 'short' });
}

function monthLong(month: string): string {
  const date = new Date(`${month}-01T00:00:00`);
  if (Number.isNaN(date.getTime())) return month;
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}
