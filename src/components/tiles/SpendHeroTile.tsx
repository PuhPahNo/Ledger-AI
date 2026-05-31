import type { SpendSummary } from '@/types/domain';
import { fmt$k } from '@/lib/format';
import { Tile } from '@/components/ui/tile';
import { MoneyDisplay } from '@/components/ui/money-display';
import { Badge } from '@/components/ui/badge';
import { StatLabel } from '@/components/ui/stat-label';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { colors } from '@/theme/tokens';
import { useResolvedColor, useTheme } from '@/hooks/useTheme';
import { Sparkline } from './Sparkline';

export type DashboardFlowMode = 'outflow' | 'inflow' | 'both';

type BusinessSegments = NonNullable<SpendSummary['trailingMonthBusinessCents']>;

interface HeroSeries {
  id: string;
  label: string;
  color: string;
  values: number[];
}

interface HeroStat {
  label: string;
  value: number;
  signed?: boolean;
}

interface HeroView {
  badge: string;
  total: number;
  signed: boolean;
  deltaPct: number;
  points: number[];
  values?: number[];
  segments?: BusinessSegments;
  series?: HeroSeries[];
  baseColor: string;
  highlightColor: string;
  stats: HeroStat[];
}

interface Props {
  summary: SpendSummary;
  contextLabel: string;
  detailLabel?: string;
  mode: DashboardFlowMode;
  onModeChange: (mode: DashboardFlowMode) => void;
}

export function SpendHeroTile({ summary, contextLabel, detailLabel, mode, onModeChange }: Props) {
  // Chart colors follow the theme so they stay visible on the (flipping) tile.
  const { theme } = useTheme();
  const inkLine = useResolvedColor('--color-ink', colors.ink);
  // Inflow green: dark sage-ink on the light tile, light sage on the dark tile
  // (sage-ink is nearly invisible against the dark background).
  const positiveGreen = theme === 'dark' ? colors.sage : colors.sageInk;
  const view = viewModel(summary, mode, inkLine, positiveGreen);
  const up = view.deltaPct >= 0;
  return (
    <Tile tone="cream" pad="lg" colSpan={8} rowSpan={2} className="gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Badge variant="default">{view.badge} · {summary.periodLabel}</Badge>
        <ToggleGroup
          type="single"
          size="sm"
          value={mode}
          onValueChange={(value) => value && onModeChange(value as DashboardFlowMode)}
        >
          <ToggleGroupItem value="inflow">In</ToggleGroupItem>
          <ToggleGroupItem value="outflow">Out</ToggleGroupItem>
          <ToggleGroupItem value="both">Both</ToggleGroupItem>
        </ToggleGroup>
        <span className="text-xs text-dim">{contextLabel}</span>
        <span className="flex-1" />
        <Badge variant={up ? 'success' : 'danger'}>
          {up ? '↗' : '↘'} {view.deltaPct >= 0 ? `+${view.deltaPct}` : view.deltaPct}%
        </Badge>
      </div>

      <MoneyDisplay size="display" className={view.total < 0 ? 'text-coral-ink' : 'text-ink'}>
        {view.signed ? fmt$kSigned(view.total) : fmt$k(view.total)}
      </MoneyDisplay>

      <div className="mt-auto grid grid-cols-[minmax(0,1fr)_auto] items-end gap-6">
        <div className="min-w-0">
          <Sparkline
            points={view.points}
            values={view.values}
            labels={summary.trailingMonthLabels}
            segments={view.segments}
            series={view.series}
            baseColor={view.baseColor}
            highlightColor={view.highlightColor}
            height={120}
          />
        </div>
        <dl className="grid w-[180px] gap-1.5 text-xs text-dim">
          <div className="font-bold text-ink">Trailing 12 months</div>
          {detailLabel && <div className="text-ink">{detailLabel}</div>}
          {view.stats.map((stat) => (
            <div key={stat.label} className="flex justify-between gap-2">
              <dt>{stat.label}</dt>
              <dd className="font-display font-bold text-ink tabular-nums">
                {'signed' in stat && stat.signed ? fmt$kSigned(stat.value) : fmt$k(stat.value)}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </Tile>
  );
}

function viewModel(summary: SpendSummary, mode: DashboardFlowMode, inkLine: string, positiveGreen: string): HeroView {
  const inflowValues = summary.trailingInflowMonthCents ?? [];
  const outflowValues = summary.trailingOutflowMonthCents ?? summary.trailingMonthCents ?? [];
  if (mode === 'inflow') {
    return {
      badge: 'INFLOW',
      total: summary.inflow ?? 0,
      signed: false,
      deltaPct: summary.inflowDeltaPct ?? 0,
      points: normalizedPoints(inflowValues),
      values: inflowValues,
      segments: summary.trailingInflowBusinessCents,
      series: undefined,
      baseColor: positiveGreen,
      highlightColor: positiveGreen,
      stats: [
        { label: 'Last month', value: summary.lastInflow ?? 0 },
        { label: 'Avg / month', value: summary.avgInflow ?? 0 },
      ],
    };
  }
  if (mode === 'both') {
    return {
      badge: 'FLOW',
      total: summary.net ?? 0,
      signed: true,
      deltaPct: summary.netDeltaPct ?? 0,
      points: Array.from({ length: Math.max(inflowValues.length, outflowValues.length, summary.trailingMonths.length) }, () => 1),
      values: undefined,
      segments: undefined,
      series: [
        { id: 'inflow', label: 'In', color: positiveGreen, values: inflowValues },
        { id: 'outflow', label: 'Out', color: colors.coral, values: outflowValues },
      ],
      baseColor: inkLine,
      highlightColor: colors.coral,
      stats: [
        { label: 'In', value: (summary.inflowCents ?? 0) / 100 },
        { label: 'Out', value: (summary.outflowCents ?? summary.totalCents ?? 0) / 100 },
        { label: 'Net', value: summary.net ?? 0, signed: true },
      ],
    };
  }
  return {
    badge: 'SPEND',
    total: summary.outflow ?? summary.total,
    signed: false,
    deltaPct: summary.outflowDeltaPct ?? summary.deltaPct,
    points: summary.trailingMonths,
    values: outflowValues,
    segments: summary.trailingOutflowBusinessCents ?? summary.trailingMonthBusinessCents,
    series: undefined,
    baseColor: inkLine,
    highlightColor: colors.coral,
    stats: [
      { label: 'Last month', value: summary.lastOutflow ?? summary.lastMonth },
      { label: 'Avg / month', value: summary.avgOutflow ?? summary.avgMonth },
    ],
  };
}

function normalizedPoints(values: number[]): number[] {
  const max = Math.max(...values, 1);
  return values.map((value) => Number((value / max).toFixed(3)));
}

function fmt$kSigned(value: number): string {
  const sign = value < 0 ? '−' : value > 0 ? '+' : '';
  return `${sign}${fmt$k(value)}`;
}

// Re-export StatLabel so tile callers can use it without a separate import path if needed elsewhere.
export { StatLabel };
