// Display formatters — keep number rendering identical across tiles.

export const fmt$ = (n: number): string =>
  (n < 0 ? '−' : '') +
  '$' +
  Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmt$k = (n: number): string =>
  '$' + Math.round(Math.abs(n)).toLocaleString('en-US');

export const fmtPctDelta = (n: number): string =>
  (n >= 0 ? '↗ ' : '↘ ') + Math.abs(n) + '%';

/** Compact money from cents: $950, $12.4K, $1.2M. `signed` always shows + / −. */
export function fmtCompactCents(cents: number, options: { signed?: boolean } = {}): string {
  const amount = cents / 100;
  const absAmount = Math.abs(amount);
  const sign = options.signed ? (amount >= 0 ? '+' : '−') : amount < 0 ? '−' : '';
  if (absAmount >= 1000) {
    return `${sign}$${new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(absAmount)}`;
  }
  return `${sign}$${absAmount.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

/** Whole-dollar money from cents: $12,345 (no cents — for KPIs and tables). */
export function fmtWholeCents(cents: number, options: { signed?: boolean } = {}): string {
  const amount = Math.round(cents / 100);
  const sign = options.signed ? (amount > 0 ? '+' : amount < 0 ? '−' : '') : amount < 0 ? '−' : '';
  return `${sign}$${Math.abs(amount).toLocaleString('en-US')}`;
}

/** "+12%" / "−8%" / "—" for a nullable percent change. */
export function fmtDeltaPct(value: number | null | undefined): string {
  if (value == null) return '—';
  if (value === 0) return '0%';
  // Changes off a near-zero base are noise at this size.
  if (Math.abs(value) > 999) return value > 0 ? '>+999%' : '<−999%';
  return `${value > 0 ? '+' : '−'}${Math.abs(value)}%`;
}
