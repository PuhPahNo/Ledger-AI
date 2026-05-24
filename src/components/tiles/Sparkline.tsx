import { useId } from 'react';
import { ChartTooltip, useChartTooltip } from '@/components/ui/chart-tooltip';

interface Segment {
  businessId: string;
  businessName: string;
  color: string;
  cents: number;
}

interface Props {
  points: number[];
  values?: number[];
  labels?: string[];
  segments?: Segment[][];
  /** Colors for prior and current (highlighted) bars. */
  baseColor: string;
  highlightColor: string;
  height?: number;
}

interface TipData {
  label: string;
  value: string;
  breakdown?: Array<{ label: string; value: string; color: string }>;
}

/** Trailing-12 sparkline: matches the design's bar chart at the bottom of the hero tile. */
export function Sparkline({ points, values = [], labels = [], segments = [], baseColor, highlightColor, height = 96 }: Props) {
  const viewWidth = 420;
  const viewHeight = 120;
  const gap = 8;
  const count = Math.max(points.length, 1);
  const w = (viewWidth - gap * (count - 1)) / count;
  const last = points.length - 1;
  const baseClipId = useId().replace(/:/g, '');

  const { tip, containerRef, show, hide } = useChartTooltip<TipData>();

  return (
    <div ref={containerRef} className="relative" onMouseLeave={hide}>
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${viewWidth} ${viewHeight}`}
        preserveAspectRatio="none"
        style={{ display: 'block', minWidth: 0 }}
      >
        {points.map((p, i) => {
          const h = Math.max(4, p * (viewHeight - 12));
          const label = labels[i] ?? `Month ${i + 1}`;
          const totalCents = values[i] ?? segments[i]?.reduce((sum, segment) => sum + segment.cents, 0) ?? 0;
          const monthSegments = segments[i]?.filter((segment) => segment.cents > 0) ?? [];
          const value = totalCents ? formatDollars(totalCents / 100) : `${Math.round(p * 100)}%`;
          const data: TipData = {
            label,
            value,
            breakdown: monthSegments.map((segment) => ({
              label: segment.businessName,
              value: formatDollars(segment.cents / 100),
              color: segment.color,
            })),
          };
          const x = i * (w + gap);
          const y = viewHeight - h;
          const clipId = `${baseClipId}-bar-${i}`;

          if (!monthSegments.length || !totalCents) {
            return (
              <rect
                key={i}
                x={x}
                y={y}
                width={w}
                height={h}
                rx={6}
                fill={i === last ? highlightColor : baseColor}
                opacity={i === last ? 1 : 0.85}
                onMouseEnter={(event) => show(data, event)}
                onMouseMove={(event) => show(data, event)}
                style={{ cursor: 'pointer' }}
              />
            );
          }

          let yCursor = viewHeight;
          return (
            <g
              key={i}
              onMouseEnter={(event) => show(data, event)}
              onMouseMove={(event) => show(data, event)}
              style={{ cursor: 'pointer' }}
            >
              <clipPath id={clipId}>
                <rect x={x} y={y} width={w} height={h} rx={6} />
              </clipPath>
              <g clipPath={`url(#${clipId})`}>
                {monthSegments.map((segment, segmentIndex) => {
                  const isLastSegment = segmentIndex === monthSegments.length - 1;
                  const segmentHeight = isLastSegment
                    ? Math.max(0, yCursor - y)
                    : Math.max(0, h * (segment.cents / totalCents));
                  yCursor -= segmentHeight;
                  if (segmentHeight <= 0) return null;
                  return (
                    <rect
                      key={`${segment.businessId}-${segmentIndex}`}
                      x={x}
                      y={yCursor}
                      width={w}
                      height={segmentHeight + 0.5}
                      fill={segment.color}
                    />
                  );
                })}
              </g>
            </g>
          );
        })}
      </svg>
      <ChartTooltip open={tip.open} x={tip.x} y={tip.y}>
        {tip.data && (
          <>
            <div className="font-bold uppercase tracking-wider text-[10px] opacity-70">{tip.data.label}</div>
            <div className="font-display font-bold tabular-nums">{tip.data.value}</div>
            {Boolean(tip.data.breakdown?.length) && (
              <div className="mt-1 grid gap-0.5">
                {tip.data.breakdown?.slice(0, 4).map((item) => (
                  <div key={item.label} className="flex items-center gap-1.5 text-[10px] opacity-80">
                    <span className="h-2 w-2 rounded-full" style={{ background: item.color }} />
                    <span className="max-w-[8rem] truncate">{item.label}</span>
                    <span className="ml-auto font-mono tabular-nums">{item.value}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </ChartTooltip>
    </div>
  );
}

function formatDollars(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
}
