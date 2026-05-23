import type { Alert } from '@/types/domain';
import { colors, fonts } from '@/theme/tokens';
import { Tile } from './Tile';

interface Props {
  alerts: Alert[];
  onReview?: (alert: Alert) => void;
  onDismiss?: (alert: Alert) => void;
}

export function AlertsTile({ alerts, onReview, onDismiss }: Props) {
  const lead = alerts[0];
  if (!lead) return null;

  return (
    <Tile bg={colors.pink} ink={colors.pinkInk} colSpan={2} rowSpan={1} style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'baseline' }}>
        <div style={{ fontFamily: fonts.mono, fontSize: 10, letterSpacing: 1.5, opacity: 0.7 }}>
          FLAGS · {alerts.length}
        </div>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, fontWeight: 600, opacity: 0.7 }}>open ↗</span>
      </div>
      <div style={{ fontFamily: fonts.display, fontSize: 18, fontWeight: 600, marginTop: 4, lineHeight: 1.2 }}>
        {lead.title}
      </div>
      <div style={{ fontSize: 11.5, marginTop: 6, opacity: 0.85, lineHeight: 1.4 }}>{lead.detail}</div>
      <div style={{ flex: 1 }} />
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <button
          type="button"
          onClick={() => onReview?.(lead)}
          style={{
            padding: '6px 12px',
            borderRadius: 99,
            background: colors.pinkInk,
            color: colors.pink,
            border: 'none',
            fontSize: 11,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Review
        </button>
        <button
          type="button"
          onClick={() => onDismiss?.(lead)}
          style={{
            padding: '6px 12px',
            borderRadius: 99,
            background: 'transparent',
            color: colors.pinkInk,
            border: `1.5px solid ${colors.pinkInk}`,
            fontSize: 11,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Dismiss
        </button>
        <span style={{ flex: 1 }} />
        {alerts.length > 1 && (
          <span style={{ fontSize: 11, alignSelf: 'center', opacity: 0.7 }}>
            +{alerts.length - 1} more
          </span>
        )}
      </div>
    </Tile>
  );
}
