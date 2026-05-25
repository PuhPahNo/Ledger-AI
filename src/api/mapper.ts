import type { Category, SpendSummary, Transaction } from '@/types/domain';

export interface ApiTransaction extends Omit<Transaction, 'amount' | 'dateLabel'> {
  amountCents: number;
  dateLabel?: string;
}

export interface ApiCategory extends Omit<Category, 'amount'> {
  amountCents: number;
}

export interface ApiSpendSummary extends Omit<SpendSummary, 'total' | 'lastMonth' | 'avgMonth'> {
  totalCents: number;
  inflowCents?: number;
  outflowCents?: number;
  netCents?: number;
  lastMonthCents?: number;
  lastInflowCents?: number;
  lastOutflowCents?: number;
  lastNetCents?: number;
  avgMonthCents?: number;
  avgInflowCents?: number;
  avgOutflowCents?: number;
  avgNetCents?: number;
  trailingMonthCents?: number[];
  trailingMonthLabels?: string[];
}

export function mapTransaction(row: ApiTransaction): Transaction {
  return {
    ...row,
    dateLabel: row.dateLabel ?? formatDateLabel(row.date),
    amount: row.amountCents / 100,
  };
}

export function mapCategory(row: ApiCategory): Category {
  return {
    ...row,
    amount: row.amountCents / 100,
  };
}

export function mapSummary(row: ApiSpendSummary): SpendSummary {
  return {
    ...row,
    total: row.totalCents / 100,
    inflow: (row.inflowCents ?? 0) / 100,
    outflow: (row.outflowCents ?? row.totalCents) / 100,
    net: (row.netCents ?? 0) / 100,
    lastMonth: (row.lastMonthCents ?? 0) / 100,
    lastInflow: (row.lastInflowCents ?? 0) / 100,
    lastOutflow: (row.lastOutflowCents ?? row.lastMonthCents ?? 0) / 100,
    lastNet: (row.lastNetCents ?? 0) / 100,
    avgMonth: (row.avgMonthCents ?? 0) / 100,
    avgInflow: (row.avgInflowCents ?? 0) / 100,
    avgOutflow: (row.avgOutflowCents ?? row.avgMonthCents ?? 0) / 100,
    avgNet: (row.avgNetCents ?? 0) / 100,
  };
}

function formatDateLabel(date: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(`${date}T00:00:00`));
}
