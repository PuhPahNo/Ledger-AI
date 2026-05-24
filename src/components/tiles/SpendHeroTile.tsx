import type { SpendSummary } from '@/types/domain';
import { colors, fonts } from '@/theme/tokens';
import { fmt$k } from '@/lib/format';
import { Tile } from './Tile';
import { Sparkline } from './Sparkline';

interface Props {
  summary: SpendSummary;
  contextLabel: string;
  detailLabel?: string;
}

export function SpendHeroTile({ summary, contextLabel, detailLabel }: Props) {
  return (
    <Tile
      bg={colors.cream}
      ink={colors.ink}
      colSpan={3}
      rowSpan={2}
      pad={20}
      style={{ display: 'flex', flexDirection: 'column' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <span
          style={{
            padding: '3px 9px',
            borderRadius: 99,
            background: colors.ink,
            color: colors.cream,
            fontSize: 10.5,
            fontWeight: 600,
            letterSpacing: 0.5,
          }}
        >
          SPEND · {summary.periodLabel}
        </span>
        <span style={{ fontSize: 11.5, color: colors.dim }}>{contextLabel}</span>
        <span style={{ flex: 1 }} />
        <span
          style={{
            fontSize: 11.5,
            color: colors.sageInk,
            background: colors.sage,
            padding: '3px 8px',
            borderRadius: 99,
            fontWeight: 600,
          }}
        >
          ↗ {summary.deltaPct}%
        </span>
      </div>
      <div
        style={{
          fontFamily: fonts.display,
          fontWeight: 600,
          fontSize: 78,
          lineHeight: 0.95,
          letterSpacing: -3,
          color: colors.ink,
          marginTop: 4,
        }}
      >
        {fmt$k(summary.total)}
      </div>
      <div
        style={{
          marginTop: 'auto',
          display: 'grid',
          gridTemplateColumns: 'minmax(260px, 1fr) auto',
          alignItems: 'end',
          gap: 18,
          minHeight: 0,
        }}
      >
        <Sparkline points={summary.trailingMonths} baseColor={colors.ink} highlightColor={colors.coral} height={112} />
        <div style={{ fontSize: 11.5, color: colors.dim, lineHeight: 1.55, minWidth: 150 }}>
          <div style={{ color: colors.ink, fontWeight: 600 }}>Trailing 12 months</div>
          {detailLabel && <div style={{ color: colors.ink }}>{detailLabel}</div>}
          <div>
            Last month: <span style={{ color: colors.ink }}>{fmt$k(summary.lastMonth)}</span>
          </div>
          <div>
            Avg: <span style={{ color: colors.ink }}>{fmt$k(summary.avgMonth)}</span>
          </div>
        </div>
      </div>
    </Tile>
  );
}
