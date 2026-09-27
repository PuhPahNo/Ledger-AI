import type { ReceiptStatus, TransactionDirection } from './domain';
import type { AppViewName } from './assistant';

/** Top-level destinations: four sidebar items plus Settings in the footer. */
export type AppView = 'home' | 'transactions' | 'reports' | 'assistant' | 'settings';

/** Transactions page modes (segmented control at the top of the page). */
export type TransactionsMode = 'transactions' | 'receipts';

/** Reports tabs. Add a tab here and register it in components/reports/reportTabs.tsx. */
export type ReportsTab = 'overview' | 'accounts' | 'close';

/** Settings sections. Add one here and register it in components/settings/settingsSections.tsx. */
export type SettingsSection = 'businesses' | 'categories' | 'receipts' | 'security' | 'data';

/** A fully resolved location in the app — what the hash encodes. */
export type AppRoute =
  | { view: 'home' }
  | { view: 'transactions'; mode: TransactionsMode }
  | { view: 'reports'; tab: ReportsTab }
  | { view: 'assistant' }
  | { view: 'settings'; section: SettingsSection };

/**
 * Old view names still arrive from bookmarks, the assistant's artifact actions and the
 * server's close-readiness items. They are redirected, never rendered.
 */
export type LegacyView = Exclude<AppViewName, AppView> | 'inbox';

/** Anything a component may ask to navigate to. */
export type NavTarget = AppView | LegacyView | AppRoute;

export type NavigateFn = (target: NavTarget) => void;

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
