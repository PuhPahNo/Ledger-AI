import { useEffect, useMemo, useState } from 'react';
import { Tags as TagsIcon } from 'lucide-react';
import { getTagTrends, listTags } from '@/api';
import type { Tag, TagTrendSeries } from '@/types/domain';
import type { AppView } from '@/types/navigation';
import { cn } from '@/lib/cn';
import { fmt$ } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ChartTooltip, useChartTooltip } from '@/components/ui/chart-tooltip';
import { EmptyState } from '@/components/ui/empty-state';
import { fmtCompactCents } from './CashFlowVisuals';

const MAX_SERIES = 10;
const DEFAULT_SERIES = 5;

interface Props {
  from: string;
  to: string;
  onViewChange?: (view: AppView) => void;
}

/**
 * Monthly outflow per custom tag (e.g. "AI") across the selected date range.
 * The tag chips are both the legend and the series toggles.
 */
export function TagTrendsCard({ from, to, onViewChange }: Props) {
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[] | null>(null); // null = not yet initialized
  const [series, setSeries] = useState<TagTrendSeries[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    listTags()
      .then((rows) => {
        const active = rows.filter((tag) => tag.active);
        setTags(active);
        setSelectedIds((current) => current ?? active.slice(0, DEFAULT_SERIES).map((tag) => tag.id));
      })
      .catch((loadError: Error) => setError(loadError.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedIds || selectedIds.length === 0) {
      setSeries([]);
      return;
    }
    getTagTrends({ tagIds: selectedIds, from, to })
      .then(setSeries)
      .catch((loadError: Error) => setError(loadError.message));
  }, [from, selectedIds, to]);

  const toggleTag = (tagId: string) => {
    setSelectedIds((current) => {
      const ids = current ?? [];
      if (ids.includes(tagId)) return ids.filter((id) => id !== tagId);
      if (ids.length >= MAX_SERIES) return ids;
      return [...ids, tagId];
    });
  };

  if (!loading && tags.length === 0 && !error) {
    return (
      <Card className="p-5">
        <CardHeading />
        <EmptyState
          title="No tags yet"
          description={'Create custom tags (e.g. "AI" for OpenAI + Anthropic spend) under Admin → Tags, then watch them trend here.'}
          icon={<TagsIcon className="h-5 w-5" />}
          action={onViewChange && (
            <Button variant="outline" size="sm" onClick={() => onViewChange('admin')}>
              Open Admin
            </Button>
          )}
        />
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <CardHeading />
        <div className="flex flex-wrap items-center gap-1.5">
          {tags.map((tag) => {
            const active = selectedIds?.includes(tag.id) ?? false;
            return (
              <button
                key={tag.id}
                type="button"
                onClick={() => toggleTag(tag.id)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-bold transition-colors',
                  active ? 'border-inverse bg-inverse text-inverse-foreground' : 'border-ink2/20 bg-cream/70 text-ink hover:border-ink2/40',
                )}
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: tag.color }} />
                {tag.name}
              </button>
            );
          })}
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-coral/30 bg-coral/10 p-4 text-sm font-bold text-coral-ink">{error}</div>
      ) : !selectedIds || selectedIds.length === 0 ? (
        <div className="flex h-[220px] items-center justify-center text-sm text-dim">
          Pick a tag above to chart its spend.
        </div>
      ) : (
        <TagTrendChart series={series} />
      )}
    </Card>
  );
}

function CardHeading() {
  return (
    <div>
      <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">Tag trends</div>
      <h2 className="font-display text-xl font-bold text-ink">Tagged spend over time</h2>
    </div>
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
  // Callback ref, not a ref+mount effect: the measured div appears only once data
  // arrives, so the observer must attach whenever the node does.
  const [measureNode, setMeasureNode] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!measureNode) return;
    setWidth(measureNode.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      setWidth(entries[0]?.contentRect.width ?? 0);
    });
    observer.observe(measureNode);
    return () => observer.disconnect();
  }, [measureNode]);

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
