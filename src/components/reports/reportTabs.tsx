import type { ComponentType } from 'react';
import type { Business } from '@/types/domain';
import type { NavigateFn, ReportsTab, TransactionViewFilters } from '@/types/navigation';
import { AccountsReport } from './AccountsReport';
import { CloseReport } from './CloseReport';
import { ContractorsReport } from './ContractorsReport';
import { OverviewReport } from './OverviewReport';

/** What every Reports tab receives. Each tab owns its own period controls and data loading. */
export interface ReportTabProps {
  /** Business key from the context-bar switcher, or 'all'. */
  business: string;
  businesses: Business[];
  onViewChange?: NavigateFn;
  onOpenTransactions?: (filters?: TransactionViewFilters) => void;
}

export interface ReportTabDefinition {
  id: ReportsTab;
  label: string;
  component: ComponentType<ReportTabProps>;
}

/**
 * The Reports tabs, in display order. To add one (e.g. phase 2's QuickBooks sync report):
 * add its id to `ReportsTab` in types/navigation.ts and to REPORT_TAB_IDS in lib/routes.ts,
 * then append an entry here. The URL becomes #reports/<id>.
 */
export const REPORT_TABS: ReportTabDefinition[] = [
  { id: 'overview', label: 'Overview', component: OverviewReport },
  { id: 'accounts', label: 'Accounts', component: AccountsReport },
  { id: 'close', label: 'Close', component: CloseReport },
  { id: 'contractors', label: 'Contractors', component: ContractorsReport },
];
