import type { ReceiptStatus, TransactionDirection } from './domain';

export type AppView = 'dashboard' | 'transactions' | 'receipts' | 'cash-flow' | 'balances' | 'insights' | 'assistant' | 'admin';

export interface TransactionViewFilters {
  business?: string;
  accountIds?: string[];
  categories?: string[];
  receipts?: ReceiptStatus[];
  direction?: TransactionDirection;
  query?: string;
  from?: string;
  to?: string;
}
