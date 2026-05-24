import { useState } from 'react';
import type { Category, CategoryComparison } from '@/types/domain';
import { accentRamp, colors } from '@/theme/tokens';
import { fmt$k } from '@/lib/format';
import { Tile } from '@/components/ui/tile';
import { StatLabel } from '@/components/ui/stat-label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
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
    <Tile tone="lemon" pad="md" colSpan={6} rowSpan={2} className="gap-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <StatLabel>CATEGORIES</StatLabel>
          <div className="mt-0.5 font-display text-xl font-bold text-lemon-ink">
            {mode === 'breakdown' ? 'Where it went' : 'Compare spend'}
          </div>
        </div>
        <Tabs value={mode} onValueChange={(value) => setMode(value as 'breakdown' | 'compare')}>
          <TabsList className="h-8 bg-lemon-ink/10">
            <TabsTrigger value="breakdown" className="h-7 text-[11px] data-[state=active]:bg-lemon-ink data-[state=active]:text-lemon">
              Breakdown
            </TabsTrigger>
            <TabsTrigger value="compare" className="h-7 text-[11px] data-[state=active]:bg-lemon-ink data-[state=active]:text-lemon">
              Compare
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {mode === 'breakdown' ? (
        <div className="grid min-h-0 flex-1 grid-cols-[auto_1fr] items-center gap-6">
          <Donut categories={visibleCategories} strokeColor={colors.lemon} labelColor={colors.lemonInk} size={180} />
          <div className="grid min-w-0 gap-1.5">
            {total <= 0 ? (
              <div className="text-sm text-lemon-ink/70">No categorized spend for this filter yet.</div>
            ) : (
              legendCategories.map((category, index) => (
                <LegendRow key={`${category.id ?? category.name}-${index}`} category={category} index={index} />
              ))
            )}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <ToggleGroup
            type="single"
            value={comparisonBasis}
            onValueChange={(value) => value && onComparisonBasisChange(value as 'month' | 'year')}
            className="self-start bg-lemon-ink/10"
          >
            <ToggleGroupItem value="month" className="data-[state=on]:bg-lemon-ink data-[state=on]:text-lemon">
              This vs Last Month
            </ToggleGroupItem>
            <ToggleGroupItem value="year" className="data-[state=on]:bg-lemon-ink data-[state=on]:text-lemon">
              This vs Last Year
            </ToggleGroupItem>
          </ToggleGroup>
          <div className="grid gap-3">
            {comparisons.length ? comparisons.slice(0, 6).map((comparison, index) => (
              <ComparisonRow key={comparison.category} comparison={comparison} index={index} />
            )) : (
              <div className="text-center text-sm text-lemon-ink/70">No comparison spend for this filter yet.</div>
            )}
          </div>
        </div>
      )}
    </Tile>
  );
}

function LegendRow({ category, index }: { category: Category; index: number }) {
  return (
    <div className="flex items-center gap-3 min-w-0 text-sm text-lemon-ink">
      <span
        className="h-2.5 w-2.5 shrink-0 rounded-sm"
        style={{ background: accentRamp[index % accentRamp.length] }}
      />
      <span className="flex-1 truncate">{category.name}</span>
      <span className="font-display font-bold tabular-nums">{fmt$k(category.amount)}</span>
    </div>
  );
}

function ComparisonRow({ comparison, index }: { comparison: CategoryComparison; index: number }) {
  const max = Math.max(comparison.current, comparison.previous, 1);
  const currentWidth = `${Math.max(4, (comparison.current / max) * 100)}%`;
  const previousWidth = `${Math.max(4, (comparison.previous / max) * 100)}%`;
  const delta = comparison.deltaPct >= 0 ? `+${comparison.deltaPct}%` : `${comparison.deltaPct}%`;

  return (
    <div className="grid gap-1 text-lemon-ink">
      <div className="flex items-baseline gap-2 text-sm">
        <div className="min-w-0 flex-1 truncate font-bold">{comparison.category}</div>
        <div className="font-display font-bold tabular-nums">{fmt$k(comparison.current)}</div>
        <div className="text-xs opacity-70">{delta}</div>
      </div>
      <div className="grid gap-1">
        <Bar width={currentWidth} color={accentRamp[index % accentRamp.length]} label="Current" />
        <Bar width={previousWidth} color={colors.ink} label="Previous" muted />
      </div>
    </div>
  );
}

function Bar({ width, color, label, muted = false }: { width: string; color: string; label: string; muted?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 font-mono text-[10px] opacity-60">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-lemon-ink/15">
        <div
          className="h-full rounded-full"
          style={{ width, background: color, opacity: muted ? 0.55 : 1 }}
        />
      </div>
    </div>
  );
}
