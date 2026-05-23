import { useState } from 'react';
import type { Category, CategoryComparison } from '@/types/domain';
import { accentRamp, colors, fonts, radii } from '@/theme/tokens';
import { fmt$k } from '@/lib/format';
import { Tile } from './Tile';
import { Donut } from './Donut';

interface Props {
  categories: Category[];
  comparisons: CategoryComparison[];
  comparisonBasis: 'month' | 'year';
  onComparisonBasisChange: (basis: 'month' | 'year') => void;
}

export function CategoriesTile({ categories, comparisons, comparisonBasis, onComparisonBasisChange }: Props) {
  const [mode, setMode] = useState<'breakdown' | 'compare'>('breakdown');
  const visibleCategories = categories.filter((category) => category.amount > 0).slice(0, 7);
  const legendCategories = visibleCategories.length ? visibleCategories : categories.slice(0, 7);
  const total = visibleCategories.reduce((sum, category) => sum + category.amount, 0);

  return (
    <Tile bg={colors.lemon} ink={colors.lemonInk} colSpan={2} rowSpan={2} pad={18} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div>
          <div style={{ fontFamily: fonts.mono, fontSize: 10, letterSpacing: 1.4, opacity: 0.72 }}>
            CATEGORIES
          </div>
          <div style={{ fontFamily: fonts.display, fontSize: 24, fontWeight: 800, marginTop: 2 }}>
            {mode === 'breakdown' ? 'Where it went' : 'Compare spend'}
          </div>
        </div>
        <span style={{ flex: 1 }} />
        <SegmentButton active={mode === 'breakdown'} onClick={() => setMode('breakdown')}>Breakdown</SegmentButton>
        <SegmentButton active={mode === 'compare'} onClick={() => setMode('compare')}>Compare</SegmentButton>
      </div>

      {mode === 'breakdown' ? (
        <>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 0 }}>
            <Donut categories={visibleCategories} strokeColor={colors.lemon} labelColor={colors.lemonInk} size={190} />
          </div>
          {total <= 0 && (
            <div style={{ textAlign: 'center', color: colors.lemonInk, opacity: 0.72, fontSize: 12, marginTop: -14 }}>
              No categorized spend for this filter yet.
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 18px', fontSize: 13 }}>
            {legendCategories.map((category, index) => (
              <LegendRow key={`${category.id ?? category.name}-${index}`} category={category} index={index} />
            ))}
          </div>
        </>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 6 }}>
            <SegmentButton active={comparisonBasis === 'month'} onClick={() => onComparisonBasisChange('month')}>This vs Last Month</SegmentButton>
            <SegmentButton active={comparisonBasis === 'year'} onClick={() => onComparisonBasisChange('year')}>This vs Last Year</SegmentButton>
          </div>
          <div style={{ display: 'grid', gap: 9, flex: 1, alignContent: 'center' }}>
            {comparisons.length ? comparisons.slice(0, 6).map((comparison, index) => (
              <ComparisonRow key={comparison.category} comparison={comparison} index={index} />
            )) : (
              <div style={{ textAlign: 'center', opacity: 0.72, fontSize: 13 }}>
                No comparison spend for this filter yet.
              </div>
            )}
          </div>
        </>
      )}
    </Tile>
  );
}

function LegendRow({ category, index }: { category: Category; index: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      <span
        style={{
          width: 10,
          height: 10,
          borderRadius: 3,
          background: accentRamp[index % accentRamp.length],
          flexShrink: 0,
        }}
      />
      <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {category.name}
      </span>
      <span style={{ fontWeight: 900, fontVariantNumeric: 'tabular-nums' }}>{fmt$k(category.amount)}</span>
    </div>
  );
}

function ComparisonRow({ comparison, index }: { comparison: CategoryComparison; index: number }) {
  const max = Math.max(comparison.current, comparison.previous, 1);
  const currentWidth = `${Math.max(4, (comparison.current / max) * 100)}%`;
  const previousWidth = `${Math.max(4, (comparison.previous / max) * 100)}%`;
  const delta = comparison.deltaPct >= 0 ? `+${comparison.deltaPct}%` : `${comparison.deltaPct}%`;

  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <div style={{ fontWeight: 900, fontSize: 13, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {comparison.category}
        </div>
        <div style={{ fontWeight: 900, fontSize: 12 }}>{fmt$k(comparison.current)}</div>
        <div style={{ fontSize: 11, opacity: 0.72 }}>{delta}</div>
      </div>
      <div style={{ display: 'grid', gap: 3 }}>
        <Bar width={currentWidth} color={accentRamp[index % accentRamp.length]} label="Current" />
        <Bar width={previousWidth} color={colors.ink} label="Previous" muted />
      </div>
    </div>
  );
}

function Bar({ width, color, label, muted = false }: { width: string; color: string; label: string; muted?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
      <span style={{ width: 42, fontSize: 9.5, opacity: 0.66, fontFamily: fonts.mono }}>{label}</span>
      <div style={{ flex: 1, height: 8, borderRadius: 99, background: 'rgba(58,47,0,0.14)', overflow: 'hidden' }}>
        <div style={{ width, height: '100%', borderRadius: 99, background: color, opacity: muted ? 0.55 : 1 }} />
      </div>
    </div>
  );
}

function SegmentButton({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: 'none',
        borderRadius: radii.pill,
        background: active ? colors.ink : 'rgba(255,255,255,0.34)',
        color: active ? colors.lemon : colors.lemonInk,
        padding: '6px 10px',
        cursor: 'pointer',
        fontSize: 11,
        fontWeight: 900,
      }}
    >
      {children}
    </button>
  );
}
