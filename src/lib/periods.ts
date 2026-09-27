// Period math shared by Home and Reports: time windows, the comparison ("prior") window,
// and the cumulative spend-pace series. Pure — no React, no API.

import {
  monthsSpanned,
  parseLocalIsoDate,
  parseMonthKey,
  shiftIsoDays,
  shiftIsoMonths,
  toLocalIsoDate,
} from './dates';

export type TimePreset = 'month' | 'last3' | 'last12' | 'ytd';

export interface TimeWindow {
  from: string;
  to: string;
  /** Short label, e.g. "SEP", "LAST 3M". */
  label: string;
  /** Human label for the picker, e.g. "September 2026". */
  display: string;
}

/** The Home time window for a picked month and preset (the preset reaches back from that month). */
export function buildTimeWindow(month: string, preset: TimePreset): TimeWindow {
  const start = parseMonthKey(month);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
  let fromDate = new Date(start);
  let label = start.toLocaleString('en-US', { month: 'short' }).toUpperCase();
  let display = start.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const rangeMonth = (date: Date) => date.toLocaleString('en-US', { month: 'short', year: 'numeric' });

  if (preset === 'last3') {
    fromDate = new Date(start.getFullYear(), start.getMonth() - 2, 1);
    label = 'LAST 3M';
    display = `${rangeMonth(fromDate)} – ${rangeMonth(end)}`;
  } else if (preset === 'last12') {
    fromDate = new Date(start.getFullYear(), start.getMonth() - 11, 1);
    label = 'LAST 12M';
    display = `${rangeMonth(fromDate)} – ${rangeMonth(end)}`;
  } else if (preset === 'ytd') {
    fromDate = new Date(start.getFullYear(), 0, 1);
    label = 'YTD';
    display = `${start.getFullYear()} year to date`;
  }
  return { from: toLocalIsoDate(fromDate), to: toLocalIsoDate(end), label, display };
}

/** Inclusive number of calendar days in [from, to]. */
export function daysInRange(from: string, to: string): number {
  const ms = parseLocalIsoDate(to).getTime() - parseLocalIsoDate(from).getTime();
  return Math.max(0, Math.round(ms / 86_400_000) + 1);
}

function isLastDayOfMonth(iso: string): boolean {
  const date = parseLocalIsoDate(iso);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getDate() === 1;
}

function lastDayOfMonth(iso: string): string {
  const date = parseLocalIsoDate(iso);
  return toLocalIsoDate(new Date(date.getFullYear(), date.getMonth() + 1, 0));
}

/**
 * The window a period is compared against.
 * - Month-aligned periods (starting on the 1st) shift back by the months they span, so
 *   September compares with August, Q3 with Q2, and "Sep 1–27" with "Aug 1–27".
 * - Anything else compares with the same number of days immediately before it.
 */
export function priorPeriod(from: string, to: string): { from: string; to: string } {
  if (parseLocalIsoDate(from).getDate() === 1) {
    const months = monthsSpanned(from, to);
    const priorFrom = shiftIsoMonths(from, -months);
    const shiftedTo = shiftIsoMonths(to, -months);
    return { from: priorFrom, to: isLastDayOfMonth(to) ? lastDayOfMonth(shiftedTo) : shiftedTo };
  }
  const days = daysInRange(from, to);
  const priorTo = shiftIsoDays(from, -1);
  return { from: shiftIsoDays(priorTo, -(days - 1)), to: priorTo };
}

/** Last day of [from, to] that has happened by `today`, or null when the window is in the future. */
export function elapsedEnd(from: string, to: string, today: string): string | null {
  if (today < from) return null;
  return today < to ? today : to;
}

export interface DailyMovement {
  date: string;
  outflowCents: number;
  inflowCents: number;
}

/** One entry per calendar day in [from, to]; days missing from `rows` are zero. */
export function densifyDaily(rows: DailyMovement[], from: string, to: string): DailyMovement[] {
  const byDate = new Map<string, DailyMovement>();
  for (const row of rows) {
    const entry = byDate.get(row.date) ?? { date: row.date, outflowCents: 0, inflowCents: 0 };
    entry.outflowCents += row.outflowCents;
    entry.inflowCents += row.inflowCents;
    byDate.set(row.date, entry);
  }
  const days = daysInRange(from, to);
  const out: DailyMovement[] = [];
  for (let index = 0; index < days; index += 1) {
    const date = shiftIsoDays(from, index);
    out.push(byDate.get(date) ?? { date, outflowCents: 0, inflowCents: 0 });
  }
  return out;
}

/** Running total: [1, 2, 3] → [1, 3, 6]. */
export function cumulative(values: number[]): number[] {
  let total = 0;
  return values.map((value) => {
    total += value;
    return total;
  });
}

/** Percent change, rounded; null when there is nothing to compare against. */
export function pctChange(current: number, previous: number): number | null {
  if (!previous) return null;
  return Math.round(((current - previous) / Math.abs(previous)) * 100);
}

export interface PaceComparison {
  currentCents: number;
  previousCents: number;
  deltaPct: number | null;
}

export interface SpendPace {
  /** Cumulative outflow for each elapsed day of the current window. */
  current: number[];
  /** Cumulative outflow for every day of the prior window. */
  previous: number[];
  /** Dates matching `current` / `previous` indexes (for tooltips). */
  currentDates: string[];
  previousDates: string[];
  /** Days elapsed in the current window (0 when it hasn't started). */
  elapsedDays: number;
  /** Totals to date vs the prior window at the same point (same day-of-month for months). */
  spend: PaceComparison;
  income: PaceComparison;
  net: PaceComparison;
}

/**
 * Month-to-date pace: cumulative spend so far vs the prior window's cumulative line, and
 * spend / income / net to date compared with the prior window at the same elapsed day.
 */
export function buildSpendPace(input: {
  window: { from: string; to: string };
  prior: { from: string; to: string };
  today: string;
  rows: DailyMovement[];
}): SpendPace {
  const asOf = elapsedEnd(input.window.from, input.window.to, input.today);
  const currentDays = asOf ? densifyDaily(input.rows, input.window.from, asOf) : [];
  const previousDays = densifyDaily(input.rows, input.prior.from, input.prior.to);
  const elapsedDays = currentDays.length;
  const compareCount = Math.min(elapsedDays, previousDays.length);
  const sum = (days: DailyMovement[], key: 'outflowCents' | 'inflowCents', count = days.length) =>
    days.slice(0, count).reduce((total, day) => total + day[key], 0);

  const spendNow = sum(currentDays, 'outflowCents');
  const spendThen = sum(previousDays, 'outflowCents', compareCount);
  const incomeNow = sum(currentDays, 'inflowCents');
  const incomeThen = sum(previousDays, 'inflowCents', compareCount);
  return {
    current: cumulative(currentDays.map((day) => day.outflowCents)),
    previous: cumulative(previousDays.map((day) => day.outflowCents)),
    currentDates: currentDays.map((day) => day.date),
    previousDates: previousDays.map((day) => day.date),
    elapsedDays,
    spend: { currentCents: spendNow, previousCents: spendThen, deltaPct: pctChange(spendNow, spendThen) },
    income: { currentCents: incomeNow, previousCents: incomeThen, deltaPct: pctChange(incomeNow, incomeThen) },
    net: {
      currentCents: incomeNow - spendNow,
      previousCents: incomeThen - spendThen,
      deltaPct: pctChange(incomeNow - spendNow, incomeThen - spendThen),
    },
  };
}

/** The part of the prior window that lines up with the elapsed part of the current one. */
export function alignedPrior(prior: { from: string; to: string }, elapsedDays: number): { from: string; to: string } | null {
  if (elapsedDays <= 0) return null;
  const end = shiftIsoDays(prior.from, elapsedDays - 1);
  return { from: prior.from, to: end < prior.to ? end : prior.to };
}
