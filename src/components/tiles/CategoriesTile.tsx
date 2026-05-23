import type { Category } from '@/types/domain';
import { accentRamp, colors, fonts } from '@/theme/tokens';
import { fmt$k } from '@/lib/format';
import { Tile } from './Tile';
import { Donut } from './Donut';

interface Props {
  categories: Category[];
}

export function CategoriesTile({ categories }: Props) {
  return (
    <Tile bg={colors.lemon} ink={colors.lemonInk} colSpan={2} rowSpan={2} style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ fontFamily: fonts.mono, fontSize: 9.5, letterSpacing: 1.5, opacity: 0.7 }}>
        CATEGORIES · MAY
      </div>
      <div style={{ fontFamily: fonts.display, fontSize: 17, fontWeight: 600, marginTop: 2, letterSpacing: -0.3 }}>
        Where it went
      </div>
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', margin: '4px 0' }}>
        <Donut categories={categories} strokeColor={colors.lemon} labelColor={colors.lemonInk} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 10px', fontSize: 10.5 }}>
        {categories.slice(0, 6).map((c, i) => (
          <div key={c.name} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: 2,
                background: accentRamp[i % accentRamp.length],
              }}
            />
            <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {c.name}
            </span>
            <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmt$k(c.amount)}</span>
          </div>
        ))}
      </div>
    </Tile>
  );
}
