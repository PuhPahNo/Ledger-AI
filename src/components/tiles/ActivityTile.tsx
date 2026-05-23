import { useState } from 'react';
import type { Business, Transaction } from '@/types/domain';
import { colors, fonts } from '@/theme/tokens';
import { fmt$ } from '@/lib/format';
import { Tile } from './Tile';

interface Props {
  transactions: Transaction[];
  businesses: Business[];
  /** Total count for the current API result set. */
  totalCount: number;
  onSelect?: (transaction: Transaction) => void;
  onViewAll?: () => void;
}

const FILTERS = ['All', 'Software', 'Travel', 'Meals'] as const;
type Filter = (typeof FILTERS)[number];

export function ActivityTile({ transactions, businesses, totalCount, onSelect, onViewAll }: Props) {
  const [filter, setFilter] = useState<Filter>('All');

  const visible = (filter === 'All' ? transactions : transactions.filter((t) => t.cat === filter)).slice(0, 7);

  return (
    <Tile
      bg={colors.paper}
      ink={colors.ink}
      colSpan={4}
      rowSpan={2}
      pad={0}
      style={{ display: 'flex', flexDirection: 'column' }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', padding: '14px 16px 8px' }}>
        <div style={{ fontFamily: fonts.display, fontSize: 16, fontWeight: 600, letterSpacing: -0.3 }}>
          Activity
        </div>
        <span style={{ marginLeft: 8, fontSize: 10.5, color: colors.dim, fontFamily: fonts.mono }}>
          {visible.length} of {totalCount}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={onViewAll}
          style={{
            border: `1px solid ${colors.ink2}`,
            borderRadius: 99,
            background: 'transparent',
            color: colors.ink,
            padding: '3px 8px',
            fontSize: 10.5,
            fontWeight: 900,
            cursor: 'pointer',
            marginRight: 6,
          }}
        >
          View all
        </button>
        <div style={{ display: 'flex', gap: 4 }}>
          {FILTERS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setFilter(s)}
              style={{
                padding: '3px 9px',
                borderRadius: 99,
                background: s === filter ? colors.ink : 'transparent',
                color: s === filter ? colors.cream : colors.dim,
                fontSize: 10.5,
                fontWeight: 500,
                cursor: 'pointer',
                border: 'none',
              }}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'hidden', padding: '0 6px 8px' }}>
        {visible.map((t, i) => (
          <ActivityRow key={t.id} transaction={t} businesses={businesses} striped={i % 2 === 1} onSelect={onSelect} />
        ))}
      </div>
    </Tile>
  );
}

function ActivityRow({
  transaction: t,
  businesses,
  striped,
  onSelect,
}: {
  transaction: Transaction;
  businesses: Business[];
  striped: boolean;
  onSelect?: (transaction: Transaction) => void;
}) {
  const b = businesses.find((x) => x.id === t.biz);
  const rcpt = receiptBadge(t.receipt);
  if (!b) return null;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect?.(t)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') onSelect?.(t);
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 10px',
        borderRadius: 10,
        background: striped ? '#fafaf6' : 'transparent',
        cursor: onSelect ? 'pointer' : 'default',
      }}
    >
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: 9,
          background: b.color + '30',
          color: b.color,
          fontWeight: 700,
          fontSize: 12,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {t.merchant[0]}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {t.merchant}
          {t.flag === 'dup-sub' && (
            <span
              style={{
                marginLeft: 8,
                fontSize: 9.5,
                padding: '1px 5px',
                borderRadius: 5,
                background: colors.pink,
                color: colors.pinkInk,
                fontWeight: 600,
              }}
            >
              DUP
            </span>
          )}
        </div>
        <div style={{ fontSize: 10.5, color: colors.dim, marginTop: 0 }}>
          {t.dateLabel} · {b.name} · {t.cat}
        </div>
      </div>
      <div
        title={rcpt.title}
        style={{
          width: 20,
          height: 20,
          borderRadius: '50%',
          background: rcpt.bg,
          color: rcpt.fg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 10.5,
          fontWeight: 700,
        }}
      >
        {rcpt.glyph}
      </div>
      <div
        style={{
          width: 84,
          textAlign: 'right',
          fontFamily: fonts.display,
          fontSize: 14,
          fontWeight: 600,
          color: t.amount > 0 ? colors.sageInk : colors.ink,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {fmt$(t.amount)}
      </div>
    </div>
  );
}

function receiptBadge(status: Transaction['receipt']) {
  switch (status) {
    case 'matched':
      return { fg: colors.sageInk, bg: colors.sage, glyph: '✓', title: 'Receipt matched' };
    case 'missing':
      return { fg: colors.coralInk, bg: colors.coral, glyph: '!', title: 'Receipt missing' };
    case 'pending':
      return { fg: colors.lemonInk, bg: colors.lemon, glyph: '…', title: 'Receipt pending OCR/match' };
    default:
      return { fg: colors.dim, bg: 'transparent', glyph: '—', title: 'Not applicable' };
  }
}
