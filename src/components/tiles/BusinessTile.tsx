import type { Business, Transaction } from '@/types/domain';
import { fonts } from '@/theme/tokens';
import { fmt$k } from '@/lib/format';
import { spendForBusiness } from '@/lib/calc';
import { Tile } from './Tile';

interface Props {
  business: Business;
  /** Tile background color. */
  bg: string;
  /** Text color used inside the tile. */
  ink: string;
  transactions: Transaction[];
  /** Free-text summary under the dollar figure — e.g. "6 txns · 1 needs receipt". */
  caption: string;
}

export function BusinessTile({ business, bg, ink, transactions, caption }: Props) {
  return (
    <Tile bg={bg} ink={ink} colSpan={1} rowSpan={1} style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ fontFamily: fonts.mono, fontSize: 9.5, letterSpacing: 1.5, opacity: 0.7 }}>
        {business.name.toUpperCase()}
      </div>
      <div
        style={{
          fontFamily: fonts.display,
          fontSize: 22,
          fontWeight: 700,
          letterSpacing: -0.6,
          marginTop: 4,
        }}
      >
        {fmt$k(spendForBusiness(transactions, business.id))}
      </div>
      <div style={{ fontSize: 10.5, marginTop: 'auto', opacity: 0.8 }}>{caption}</div>
    </Tile>
  );
}
