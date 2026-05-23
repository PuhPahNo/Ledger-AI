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
  lastMonthCents?: number;
  avgMonthCents?: number;
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
    lastMonth: (row.lastMonthCents ?? 0) / 100,
    avgMonth: (row.avgMonthCents ?? 0) / 100,
  };
}

function formatDateLabel(date: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(`${date}T00:00:00`));
}
