// Display formatters — keep number rendering identical across tiles.

export const fmt$ = (n: number): string =>
  (n < 0 ? '−' : '') +
  '$' +
  Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmt$k = (n: number): string =>
  '$' + Math.round(Math.abs(n)).toLocaleString('en-US');

export const fmtPctDelta = (n: number): string =>
  (n >= 0 ? '↗ ' : '↘ ') + Math.abs(n) + '%';
