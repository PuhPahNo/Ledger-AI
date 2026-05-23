import type { Connection } from '@/types/domain';
import { colors, fonts } from '@/theme/tokens';
import { Tile } from './Tile';

interface Props {
  connections: Connection[];
  onAdd?: () => void;
}

export function ConnectionsTile({ connections, onAdd }: Props) {
  return (
    <Tile bg={colors.paper} ink={colors.ink} colSpan={2} rowSpan={1}>
      <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: 8 }}>
        <div style={{ fontFamily: fonts.display, fontSize: 15, fontWeight: 600 }}>Connections</div>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: colors.dim }}>{connections.length} active</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {connections.map((c, i) => (
          <ConnectionChip key={i} connection={c} />
        ))}
        <button
          type="button"
          onClick={onAdd}
          style={{
            padding: '5px 10px',
            borderRadius: 99,
            background: 'transparent',
            border: `1.5px dashed ${colors.ink2}`,
            color: colors.ink2,
            fontSize: 11,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          + add
        </button>
      </div>
    </Tile>
  );
}

function ConnectionChip({ connection: c }: { connection: Connection }) {
  const live = c.status === 'live';
  const bg = live ? colors.sage : colors.pink;
  const fg = live ? colors.sageInk : colors.pinkInk;
  const label = c.kind === 'gmail' ? c.label.split('@')[0] : c.mask ?? c.label;

  return (
    <div
      title={`${c.label} · ${c.status} · ${c.last}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 10px',
        borderRadius: 99,
        background: bg,
        color: fg,
        fontSize: 11,
        fontWeight: 600,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: fg }} />
      {label}
    </div>
  );
}
