import type { ReceiptStatus, TransactionDirection } from './domain';

export type AppView = 'dashboard' | 'inbox' | 'transactions' | 'receipts' | 'cash-flow' | 'balances' | 'insights' | 'assistant' | 'admin';

export interface TransactionViewFilters {
  business?: string;
  accountIds?: string[];
  categories?: string[];
  receipts?: ReceiptStatus[];
  tagIds?: string[];
  direction?: TransactionDirection;
  query?: string;
  from?: string;
  to?: string;
}
