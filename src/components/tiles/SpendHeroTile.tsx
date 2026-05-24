import type { SpendSummary } from '@/types/domain';
import { fmt$k } from '@/lib/format';
import { Tile } from '@/components/ui/tile';
import { MoneyDisplay } from '@/components/ui/money-display';
import { Badge } from '@/components/ui/badge';
import { StatLabel } from '@/components/ui/stat-label';
import { colors } from '@/theme/tokens';
import { Sparkline } from './Sparkline';

interface Props {
  summary: SpendSummary;
  contextLabel: string;
  detailLabel?: string;
}

export function SpendHeroTile({ summary, contextLabel, detailLabel }: Props) {
  const up = summary.deltaPct >= 0;
  return (
    <Tile tone="cream" pad="lg" colSpan={8} rowSpan={2} className="gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Badge variant="default">SPEND · {summary.periodLabel}</Badge>
        <span className="text-xs text-dim">{contextLabel}</span>
        <span className="flex-1" />
        <Badge variant={up ? 'success' : 'danger'}>
          {up ? '↗' : '↘'} {summary.deltaPct >= 0 ? `+${summary.deltaPct}` : summary.deltaPct}%
        </Badge>
      </div>

      <MoneyDisplay size="display" className="text-ink">
        {fmt$k(summary.total)}
      </MoneyDisplay>

      <div className="mt-auto grid grid-cols-[minmax(0,1fr)_auto] items-end gap-6">
        <div className="min-w-0">
          <Sparkline
            points={summary.trailingMonths}
            values={summary.trailingMonthCents}
            labels={summary.trailingMonthLabels}
            baseColor={colors.ink}
            highlightColor={colors.coral}
            height={120}
          />
        </div>
        <dl className="grid w-[180px] gap-1.5 text-xs text-dim">
          <div className="font-bold text-ink">Trailing 12 months</div>
          {detailLabel && <div className="text-ink">{detailLabel}</div>}
          <div className="flex justify-between gap-2">
            <dt>Last month</dt>
            <dd className="font-display font-bold text-ink tabular-nums">{fmt$k(summary.lastMonth)}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt>Avg / month</dt>
            <dd className="font-display font-bold text-ink tabular-nums">{fmt$k(summary.avgMonth)}</dd>
          </div>
        </dl>
      </div>
    </Tile>
  );
}

// Re-export StatLabel so tile callers can use it without a separate import path if needed elsewhere.
export { StatLabel };
