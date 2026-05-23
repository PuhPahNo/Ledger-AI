interface Props {
  points: number[];
  /** Colors for prior and current (highlighted) bars. */
  baseColor: string;
  highlightColor: string;
}

/** Trailing-12 sparkline: matches the design's bar chart at the bottom of the hero tile. */
export function Sparkline({ points, baseColor, highlightColor }: Props) {
  const w = 16;
  const gap = 4;
  const last = points.length - 1;

  return (
    <svg width="200" height="56" viewBox="0 0 240 68" style={{ flex: '0 0 auto' }}>
      {points.map((p, i) => {
        const h = p * 60;
        return (
          <rect
            key={i}
            x={i * (w + gap)}
            y={64 - h}
            width={w}
            height={h}
            rx={4}
            fill={i === last ? highlightColor : baseColor}
            opacity={i === last ? 1 : 0.85}
          />
        );
      })}
    </svg>
  );
}
