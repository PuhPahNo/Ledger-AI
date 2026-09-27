// Local-calendar date helpers.
//
// Every date the UI sends to the API is a plain calendar day (YYYY-MM-DD) or
// month (YYYY-MM). `Date#toISOString()` converts to UTC first, so in US
// timezones "today" flips to tomorrow in the evening and `new Date(y, m, 1)`
// can serialize as the last day of the previous month. These helpers always
// format from the local calendar fields instead.

const pad = (value: number) => String(value).padStart(2, '0');

/** YYYY-MM-DD for the local calendar day of `date`. */
export function toLocalIsoDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** YYYY-MM for the local calendar month of `date`. */
export function toLocalMonthKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

/** Parse a YYYY-MM-DD string as local midnight (never UTC). */
export function parseLocalIsoDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1);
}

/** Parse a YYYY-MM string as the first day of that local month. */
export function parseMonthKey(value: string): Date {
  const [year, month] = value.split('-').map(Number);
  return new Date(year, (month ?? 1) - 1, 1);
}

export function todayIso(now: Date = new Date()): string {
  return toLocalIsoDate(now);
}

export function currentMonthKey(now: Date = new Date()): string {
  return toLocalMonthKey(now);
}

export function startOfMonthIso(now: Date = new Date()): string {
  return toLocalIsoDate(new Date(now.getFullYear(), now.getMonth(), 1));
}

/** First and last calendar day of a YYYY-MM month. */
export function monthBounds(monthKey: string): { from: string; to: string } {
  const start = parseMonthKey(monthKey);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
  return { from: toLocalIsoDate(start), to: toLocalIsoDate(end) };
}

export function shiftIsoDays(value: string, delta: number): string {
  const date = parseLocalIsoDate(value);
  date.setDate(date.getDate() + delta);
  return toLocalIsoDate(date);
}

/** Shift by whole months, clamping to the last day of the target month (Mar 31 − 1m = Feb 28/29). */
export function shiftIsoMonths(value: string, delta: number): string {
  const date = parseLocalIsoDate(value);
  const target = new Date(date.getFullYear(), date.getMonth() + delta, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(date.getDate(), lastDay));
  return toLocalIsoDate(target);
}

export function shiftMonthKey(monthKey: string, delta: number): string {
  const start = parseMonthKey(monthKey);
  return toLocalMonthKey(new Date(start.getFullYear(), start.getMonth() + delta, 1));
}

/** First day of the month `months - 1` before `to`'s month — i.e. a trailing N-month window ending at `to`. */
export function trailingMonthsFrom(to: string, months: number): string {
  const end = parseLocalIsoDate(to);
  return toLocalIsoDate(new Date(end.getFullYear(), end.getMonth() - (months - 1), 1));
}

/** Number of calendar months touched by [from, to] (inclusive). */
export function monthsSpanned(from: string, to: string): number {
  const start = parseLocalIsoDate(from);
  const end = parseLocalIsoDate(to);
  return (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) + 1;
}

/** The YYYY-MM a range belongs to when it sits inside one calendar month, else null. */
export function singleMonthOfRange(from: string, to: string): string | null {
  if (!from || !to) return null;
  return from.slice(0, 7) === to.slice(0, 7) ? from.slice(0, 7) : null;
}

export function formatMonthLabel(monthKey: string, style: 'long' | 'short' = 'long'): string {
  return parseMonthKey(monthKey).toLocaleDateString('en-US', { month: style, year: 'numeric' });
}
