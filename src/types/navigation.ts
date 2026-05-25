export type AppView = 'dashboard' | 'transactions' | 'receipts' | 'cash-flow' | 'balances' | 'insights' | 'assistant' | 'admin';

export interface TransactionViewFilters {
  business?: string;
  accountIds?: string[];
  query?: string;
  from?: string;
  to?: string;
}
