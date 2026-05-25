export type AppView = 'dashboard' | 'transactions' | 'admin';

export interface TransactionViewFilters {
  business?: string;
  accountIds?: string[];
  query?: string;
  from?: string;
  to?: string;
}
