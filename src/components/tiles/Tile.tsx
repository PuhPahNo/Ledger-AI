import type { CSSProperties, ReactNode } from 'react';
import { radii } from '@/theme/tokens';

export interface TileProps {
  bg: string;
  ink: string;
  /** Grid column span (1–6). */
  colSpan: number;
  /** Grid row span (1–4). */
  rowSpan: number;
  pad?: number | string;
  style?: CSSProperties;
  children?: ReactNode;
}

/** The single Bento tile primitive — every dashboard card is one of these. */
export function Tile({ bg, ink, colSpan, rowSpan, pad = 14, style, children }: TileProps) {
  return (
    <div
      style={{
        background: bg,
        color: ink,
        borderRadius: radii.tile,
        padding: pad,
        position: 'relative',
        overflow: 'hidden',
        minWidth: 0,
        minHeight: 0,
        gridColumn: `span ${colSpan}`,
        gridRow: `span ${rowSpan}`,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
