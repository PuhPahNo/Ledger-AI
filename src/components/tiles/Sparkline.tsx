import { ChartTooltip, useChartTooltip } from '@/components/ui/chart-tooltip';

interface Props {
  points: number[];
  values?: number[];
  labels?: string[];
  /** Colors for prior and current (highlighted) bars. */
  baseColor: string;
  highlightColor: string;
  height?: number;
}

interface TipData {
  label: string;
  value: string;
}

/** Trailing-12 sparkline: matches the design's bar chart at the bottom of the hero tile. */
export function Sparkline({ points, values = [], labels = [], baseColor, highlightColor, height = 96 }: Props) {
  const viewWidth = 420;
  const viewHeight = 120;
  const gap = 8;
  const count = Math.max(points.length, 1);
  const w = (viewWidth - gap * (count - 1)) / count;
  const last = points.length - 1;

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
          const value = values[i] != null ? formatDollars(values[i] / 100) : `${Math.round(p * 100)}%`;
          const data: TipData = { label, value };
          return (
            <rect
              key={i}
              x={i * (w + gap)}
              y={viewHeight - h}
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
        })}
      </svg>
      <ChartTooltip open={tip.open} x={tip.x} y={tip.y}>
        {tip.data && (
          <>
            <div className="font-bold uppercase tracking-wider text-[10px] opacity-70">{tip.data.label}</div>
            <div className="font-display font-bold tabular-nums">{tip.data.value}</div>
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
