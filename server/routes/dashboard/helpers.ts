import { inArray, sql } from 'drizzle-orm';
import { accounts, businesses, categories, transactions } from '../../db/schema.js';

export type TransactionDirection = 'all' | 'inflow' | 'outflow' | 'operating-outflow' | 'transfer';
export type FlowBucketPreset = 'month' | 'last3' | 'last12' | 'ytd';
export type FlowBucketGranularity = 'day' | 'week' | 'month';

const receiptStatuses = ['matched', 'pending', 'missing', 'n/a', 'waived'] as const;
export type ReceiptStatus = typeof receiptStatuses[number];

export function normalizeInsightMetric(row?: { count?: number | null; cents?: number | null }) {
  return {
    count: Number(row?.count ?? 0),
    cents: Number(row?.cents ?? 0),
  };
}

export function averageCents(values: number[]): number {
  return Math.round(values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1));
}

export function dateWindow(period?: string, from?: string, to?: string) {
  if (from && to) return { from, to, label: rangeLabel(from, to) };
  return monthWindow(period ?? new Date().toISOString().slice(0, 7));
}

export function comparisonWindow(period: string, basis: 'month' | 'year') {
  const start = new Date(`${period}-01T00:00:00`);
  if (basis === 'year') {
    return {
      currentFrom: isoDate(new Date(start.getFullYear(), 0, 1)),
      currentTo: isoDate(new Date(start.getFullYear(), 11, 31)),
      previousFrom: isoDate(new Date(start.getFullYear() - 1, 0, 1)),
      previousTo: isoDate(new Date(start.getFullYear() - 1, 11, 31)),
    };
  }
  return {
    currentFrom: isoDate(start),
    currentTo: isoDate(new Date(start.getFullYear(), start.getMonth() + 1, 0)),
    previousFrom: isoDate(new Date(start.getFullYear(), start.getMonth() - 1, 1)),
    previousTo: isoDate(new Date(start.getFullYear(), start.getMonth(), 0)),
  };
}

export function comparisonWindowForRange(from: string, to: string, basis: 'month' | 'year') {
  if (basis === 'year') {
    const start = dateFromIso(from);
    const end = dateFromIso(to);
    return {
      currentFrom: from,
      currentTo: to,
      previousFrom: isoDate(new Date(start.getFullYear() - 1, start.getMonth(), start.getDate())),
      previousTo: isoDate(new Date(end.getFullYear() - 1, end.getMonth(), end.getDate())),
    };
  }
  const previous = previousDateWindow(from, to);
  return {
    currentFrom: from,
    currentTo: to,
    previousFrom: previous.priorFrom,
    previousTo: previous.priorTo,
  };
}

export function monthWindow(period: string) {
  const start = new Date(`${period}-01T00:00:00`);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
  const priorStart = new Date(start.getFullYear(), start.getMonth() - 1, 1);
  const priorEnd = new Date(start.getFullYear(), start.getMonth(), 0);
  return {
    from: isoDate(start),
    to: isoDate(end),
    priorFrom: isoDate(priorStart),
    priorTo: isoDate(priorEnd),
    label: start.toLocaleString('en-US', { month: 'short' }).toUpperCase(),
  };
}

export function previousDateWindow(from: string, to: string) {
  const start = dateFromIso(from);
  const end = dateFromIso(to);
  const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000) + 1);
  const priorEnd = new Date(start);
  priorEnd.setDate(priorEnd.getDate() - 1);
  const priorStart = new Date(priorEnd);
  priorStart.setDate(priorStart.getDate() - (days - 1));
  return {
    priorFrom: isoDate(priorStart),
    priorTo: isoDate(priorEnd),
  };
}

export function cashFlowPeriods(from: string, to: string, group: 'month' | 'year') {
  const start = dateFromIso(from);
  const end = dateFromIso(to);
  const periods: Array<{ label: string; from: string; to: string }> = [];
  const cursor = group === 'year'
    ? new Date(start.getFullYear(), 0, 1)
    : new Date(start.getFullYear(), start.getMonth(), 1);
  while (cursor <= end) {
    const periodStart = group === 'year'
      ? new Date(cursor.getFullYear(), 0, 1)
      : new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const periodEnd = group === 'year'
      ? new Date(cursor.getFullYear(), 11, 31)
      : new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    periods.push({
      label: group === 'year'
        ? String(cursor.getFullYear())
        : cursor.toLocaleString('en-US', { month: 'short', year: '2-digit' }),
      from: isoDate(periodStart < start ? start : periodStart),
      to: isoDate(periodEnd > end ? end : periodEnd),
    });
    if (group === 'year') cursor.setFullYear(cursor.getFullYear() + 1);
    else cursor.setMonth(cursor.getMonth() + 1);
  }
  return periods;
}

export function shiftIsoYear(value: string, delta: number): string {
  const date = dateFromIso(value);
  date.setFullYear(date.getFullYear() + delta);
  return isoDate(date);
}

export function flowBucketWindows(from: string, to: string, preset?: FlowBucketPreset): {
  granularity: FlowBucketGranularity;
  windows: Array<{ from: string; to: string; label: string }>;
} {
  const granularity = preset === 'last3'
    ? 'week'
    : preset === 'last12' || preset === 'ytd'
      ? 'month'
      : preset === 'month'
        ? 'day'
        : inferBucketGranularity(from, to);
  if (granularity === 'day') return { granularity, windows: dailyWindows(from, to) };
  if (granularity === 'week') return { granularity, windows: weeklyWindows(from, to) };
  return { granularity, windows: monthlyWindows(from, to) };
}

export function trailingMonthWindows(to: string) {
  const end = dateFromIso(to);
  return Array.from({ length: 12 }, (_, index) => {
    const date = new Date(end.getFullYear(), end.getMonth() - (11 - index), 1);
    return {
      from: isoDate(date),
      to: isoDate(new Date(date.getFullYear(), date.getMonth() + 1, 0)),
      label: date.toLocaleString('en-US', { month: 'short', year: '2-digit' }),
    };
  });
}

function inferBucketGranularity(from: string, to: string): FlowBucketGranularity {
  const days = Math.max(1, Math.round((dateFromIso(to).getTime() - dateFromIso(from).getTime()) / 86400000) + 1);
  if (days <= 45) return 'day';
  if (days <= 120) return 'week';
  return 'month';
}

function dailyWindows(from: string, to: string) {
  const end = dateFromIso(to);
  const cursor = dateFromIso(from);
  const windows: Array<{ from: string; to: string; label: string }> = [];
  while (cursor <= end) {
    windows.push({
      from: isoDate(cursor),
      to: isoDate(cursor),
      label: cursor.toLocaleString('en-US', { month: 'short', day: 'numeric' }),
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return windows;
}

function weeklyWindows(from: string, to: string) {
  const end = dateFromIso(to);
  const cursor = dateFromIso(from);
  const windows: Array<{ from: string; to: string; label: string }> = [];
  while (cursor <= end) {
    const start = new Date(cursor);
    const weekEnd = new Date(cursor);
    weekEnd.setDate(weekEnd.getDate() + 6);
    const cappedEnd = weekEnd > end ? end : weekEnd;
    windows.push({
      from: isoDate(start),
      to: isoDate(cappedEnd),
      label: start.toLocaleString('en-US', { month: 'short', day: 'numeric' }),
    });
    cursor.setDate(cursor.getDate() + 7);
  }
  return windows;
}

function monthlyWindows(from: string, to: string) {
  const start = dateFromIso(from);
  const end = dateFromIso(to);
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  const windows: Array<{ from: string; to: string; label: string }> = [];
  while (cursor <= end) {
    const periodStart = new Date(cursor);
    const periodEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    windows.push({
      from: isoDate(periodStart < start ? start : periodStart),
      to: isoDate(periodEnd > end ? end : periodEnd),
      label: cursor.toLocaleString('en-US', { month: 'short', year: '2-digit' }),
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return windows;
}

function rangeLabel(from: string, to: string): string {
  const start = dateFromIso(from);
  const end = dateFromIso(to);
  const sameMonth = start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth();
  if (sameMonth) return start.toLocaleString('en-US', { month: 'short' }).toUpperCase();
  return `${start.toLocaleString('en-US', { month: 'short' }).toUpperCase()}-${end.toLocaleString('en-US', { month: 'short' }).toUpperCase()}`;
}

export function dateFromIso(value: string): Date {
  return new Date(`${value}T00:00:00`);
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function parseAccountIds(value?: string): string[] {
  return parseList(value);
}

export function parseList(value?: string): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function accountSpendFilter(accountIds: string[]) {
  return sql`(${transactions.accountId} IS NULL OR ${accounts.id} IS NULL OR ${accounts.enabled} = true)
    AND ${accountIds.length ? inArray(transactions.accountId, accountIds) : sql`true`}`;
}

export function spendCategoryFilter() {
  return sql`${categoryIsVisibleSpend()}`;
}

export function categoryIsVisibleSpend() {
  return sql`NOT (${transferCategoryFilter()})
    AND NOT (
      coalesce(${categories.taxCode}, '') = 'income'
      OR lower(coalesce(${categories.name}, '')) IN ('income', 'revenue')
    )`;
}

export function transferCategoryFilter() {
  return sql`coalesce(${categories.taxCode}, '') LIKE 'exclude_%'
    OR lower(coalesce(${categories.name}, '')) = 'transfers'`;
}

export function transactionDirectionFilter(direction: TransactionDirection) {
  switch (direction) {
    case 'inflow':
      return sql`${transactions.amountCents} > 0`;
    case 'outflow':
      return sql`${transactions.amountCents} < 0`;
    case 'operating-outflow':
      return sql`${transactions.amountCents} < 0 AND ${categoryIsVisibleSpend()}`;
    case 'transfer':
      return transferCategoryFilter();
    default:
      return sql`true`;
  }
}

export function joinedTransactionSpendFilter(accountIds: string[]) {
  return sql`${transactions.id} IS NULL OR (${accountSpendFilter(accountIds)})`;
}

export function transactionSortColumn(sort: 'date' | 'amount' | 'largest' | 'merchant' | 'business' | 'category' | 'account') {
  switch (sort) {
    case 'amount':
      return transactions.amountCents;
    case 'largest':
      return sql`abs(${transactions.amountCents})`;
    case 'merchant':
      return transactions.merchant;
    case 'business':
      return businesses.name;
    case 'category':
      return categories.name;
    case 'account':
      return transactions.sourceLabel;
    default:
      return transactions.date;
  }
}

export function isReceiptStatus(value: string): value is ReceiptStatus {
  return (receiptStatuses as readonly string[]).includes(value);
}
