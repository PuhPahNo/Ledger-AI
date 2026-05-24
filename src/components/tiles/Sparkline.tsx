interface Props {
  points: number[];
  /** Colors for prior and current (highlighted) bars. */
  baseColor: string;
  highlightColor: string;
  height?: number;
}

/** Trailing-12 sparkline: matches the design's bar chart at the bottom of the hero tile. */
export function Sparkline({ points, baseColor, highlightColor, height = 96 }: Props) {
  const viewWidth = 420;
  const viewHeight = 120;
  const gap = 8;
  const count = Math.max(points.length, 1);
  const w = (viewWidth - gap * (count - 1)) / count;
  const last = points.length - 1;

  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${viewWidth} ${viewHeight}`}
      preserveAspectRatio="none"
      style={{ display: 'block', minWidth: 0 }}
    >
      {points.map((p, i) => {
        const h = Math.max(4, p * (viewHeight - 12));
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
          />
        );
      })}
    </svg>
  );
}
