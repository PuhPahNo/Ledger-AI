import type { Category } from '@/types/domain';
import { accentRamp, colors, fonts } from '@/theme/tokens';
import { fmt$k } from '@/lib/format';

interface Props {
  categories: Category[];
  /** Tile background — used as the stroke between donut slices so they look separated. */
  strokeColor: string;
  /** Color of the center total label. */
  labelColor: string;
}

/** SVG donut chart for the Categories tile. */
export function Donut({ categories, strokeColor, labelColor }: Props) {
  const total = categories.reduce((a, c) => a + c.amount, 0);
  let acc = 0;
  const r = 42;
  const ri = 26;

  return (
    <svg width="112" height="112" viewBox="0 0 100 100">
      {categories.map((c, i) => {
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
        return (
          <path
            key={c.name}
            d={`M${x0},${y0} A${r},${r} 0 ${large} 1 ${x1},${y1} L${xi1},${yi1} A${ri},${ri} 0 ${large} 0 ${xi0},${yi0} Z`}
            fill={accentRamp[i % accentRamp.length]}
            stroke={strokeColor}
            strokeWidth={1.5}
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
      >
        {fmt$k(total)}
      </text>
    </svg>
  );
}
