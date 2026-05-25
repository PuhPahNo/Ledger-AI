export type AppView = 'dashboard' | 'transactions' | 'cash-flow' | 'balances' | 'insights' | 'assistant' | 'admin';

export interface TransactionViewFilters {
  business?: string;
  accountIds?: string[];
  query?: string;
  from?: string;
  to?: string;
}
