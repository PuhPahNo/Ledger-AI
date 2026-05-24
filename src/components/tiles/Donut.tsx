import type { Category } from '@/types/domain';
import { accentRamp, colors, fonts } from '@/theme/tokens';
import { fmt$k } from '@/lib/format';
import { ChartTooltip, useChartTooltip } from '@/components/ui/chart-tooltip';

interface Props {
  categories: Category[];
  /** Tile background — used as the stroke between donut slices so they look separated. */
  strokeColor: string;
  /** Color of the center total label. */
  labelColor: string;
  size?: number;
}

interface TipData {
  name: string;
  amount: number;
  pct: number;
}

/** SVG donut chart for the Categories tile. */
export function Donut({ categories, strokeColor, labelColor, size = 112 }: Props) {
  const total = categories.reduce((a, c) => a + c.amount, 0);
  let acc = 0;
  const r = 42;
  const ri = 26;

  const { tip, containerRef, show, hide } = useChartTooltip<TipData>();

  return (
    <div ref={containerRef} className="relative inline-block" onMouseLeave={hide}>
      <svg width={size} height={size} viewBox="0 0 100 100">
        {total <= 0 && (
          <circle cx={50} cy={50} r={36} fill="none" stroke={labelColor} strokeWidth={10} opacity={0.16} />
        )}
        {total > 0 && categories.map((c, i) => {
          const frac = c.amount / total;
          const a0 = acc * 2 * Math.PI - Math.PI / 2;
          const a1 = (acc + frac) * 2 * Math.PI - Math.PI / 2;
          acc += frac;
          const x0 = 50 + r * Math.cos(a0);
          const y0 = 50 + r * Math.sin(a0);
          const x1 = 50 + r * Math.cos(a1);
          const y1 = 50 + r * Math.sin(a1);
          const xi1 = 50 + ri * Math.cos(a1);
          const yi1 = 50 + ri * Math.sin(a1);
          const xi0 = 50 + ri * Math.cos(a0);
          const yi0 = 50 + ri * Math.sin(a0);
          const large = frac > 0.5 ? 1 : 0;
          const data: TipData = { name: c.name, amount: c.amount, pct: frac * 100 };
          return (
            <path
              key={c.name}
              d={`M${x0},${y0} A${r},${r} 0 ${large} 1 ${x1},${y1} L${xi1},${yi1} A${ri},${ri} 0 ${large} 0 ${xi0},${yi0} Z`}
              fill={accentRamp[i % accentRamp.length]}
              stroke={strokeColor}
              strokeWidth={1.5}
              onMouseEnter={(event) => show(data, event)}
              onMouseMove={(event) => show(data, event)}
              style={{ cursor: 'pointer' }}
            />
          );
        })}
        <text
          x={50}
          y={50}
          textAnchor="middle"
          dominantBaseline="middle"
          fontFamily={fonts.display}
          fontWeight={700}
          fontSize={12}
          fill={labelColor || colors.lemonInk}
          pointerEvents="none"
        >
          {fmt$k(total)}
        </text>
      </svg>
      <ChartTooltip open={tip.open} x={tip.x} y={tip.y}>
        {tip.data && (
          <>
            <div className="font-bold uppercase tracking-wider text-[10px] opacity-70">{tip.data.name}</div>
            <div className="font-display font-bold tabular-nums">{fmt$k(tip.data.amount)}</div>
            <div className="text-[10px] opacity-70">{tip.data.pct.toFixed(1)}% of spend</div>
          </>
        )}
      </ChartTooltip>
    </div>
  );
}
