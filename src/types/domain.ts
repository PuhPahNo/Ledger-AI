// Single source of truth for the shapes the UI consumes.
// The API layer is responsible for mapping backend responses to these types,
// so the UI never has to care about Plaid / Gmail / Stripe wire formats.

export type BusinessId = string;

export interface Business {
  id: BusinessId;
  dbId?: string;
  name: string;
  short: string;
  /** Hex used everywhere this business is shown. */
  color: string;
  hue: number;
  active?: boolean;
}

export type ReceiptStatus =
  | 'matched'   // a receipt is attached and verified
  | 'pending'   // a receipt was uploaded/found but not yet matched
  | 'missing'   // no receipt; user needs to upload or it needs gmail scan
  | 'n/a';      // inflow / non-receiptable

export type TransactionFlag =
  | 'dup-sub'      // duplicate subscription suspected
  | 'no-receipt'   // receipt missing past the SLA window
  | 'spike';       // unusual size vs trailing average

export interface Transaction {
  id: string;
  businessId?: string;
  accountId?: string | null;
  categoryId?: string | null;
  receiptId?: string | null;
  /** ISO 8601 date — UI formats it via lib/format. */
  date: string;
  /** Display string for now ("May 22"); backend should send ISO + we'll format. */
  dateLabel: string;
  merchant: string;
  /** Negative = outflow, positive = inflow. Cents would be safer; using dollars to match the mock. */
  amount: number;
  amountCents?: number;
  biz: BusinessId;
  cat: string;
  categoryTaxCode?: string | null;
  categorySource?: CategorySource;
  categoryConfidence?: number;
  categoryEvidence?: Record<string, unknown>;
  receipt: ReceiptStatus;
  /** "Amex •• 4002" — display only; backend owns the canonical account id. */
  src: string;
  note?: string;
  flag?: TransactionFlag;
}

export type TransactionDirection = 'all' | 'inflow' | 'outflow' | 'operating-outflow' | 'transfer';

export interface TransactionRollup {
  rows: number;
  inflowCents: number;
  outflowCents: number;
  operatingOutflowCents: number;
  transferCents: number;
  netCents: number;
  missingReceipts: number;
}

export interface Category {
  id?: string;
  businessId?: string | null;
  name: string;
  taxCode?: string | null;
  amount: number;
  amountCents?: number;
  /** "+12%", "-8%". Pre-formatted by the backend or by lib/calc. */
  delta: string;
  count: number;
}

export interface CategoryComparison {
  category: string;
  current: number;
  currentCents?: number;
  previous: number;
  previousCents?: number;
  deltaPct: number;
}

export type ConnectionKind = 'bank' | 'card' | 'gmail';
export type ConnectionStatus = 'live' | 'reauth' | 'disconnected';

export interface Connection {
  id?: string;
  businessId?: string | null;
  kind: ConnectionKind;
  label: string;
  /** Card last-four or bank mask — undefined for gmail. */
  mask?: string;
  status: ConnectionStatus;
  /** Display string ("2 min ago", "just now") — backend can send ISO + we format. */
  last: string;
  lastSyncAt?: string | null;
  txns: number;
  biz: BusinessId | 'all';
}

export type AccountKind = 'checking' | 'savings' | 'credit' | 'other';

export interface Account {
  id: string;
  connectionId: string;
  businessId?: string | null;
  biz: BusinessId | 'all';
  kind: AccountKind;
  name: string;
  /** User-chosen display name. Falls back to `name` when null. */
  nickname?: string | null;
  officialName?: string | null;
  mask?: string | null;
  enabled: boolean;
  currentBalanceCents?: number | null;
  availableBalanceCents?: number | null;
  connectionLabel?: string;
  connectionStatus?: ConnectionStatus;
}

export type AlertKind = 'dup' | 'missing' | 'orphan' | 'spike' | 'reauth';
export type AlertSeverity = 'warn' | 'todo' | 'info';

export interface Alert {
  id?: string;
  kind: AlertKind;
  title: string;
  detail: string;
  severity: AlertSeverity;
}

export type CategorySource =
  | 'manual'
  | 'user_confirmed_rule'
  | 'auto_rule'
  | 'plaid_signal'
  | 'ai_suggested'
  | 'receipt_evidence'
  | 'uncategorized';

export type CategorizationReviewType =
  | 'learn_rule_prompt'
  | 'ai_category_suggestion'
  | 'receipt_category_override'
  | 'rule_conflict_review';

export type CategorizationReviewStatus = 'open' | 'accepted' | 'dismissed' | 'expired';

export interface CategorizationReviewItem {
  id: string;
  businessId: string;
  biz: BusinessId | 'all';
  type: CategorizationReviewType;
  status: CategorizationReviewStatus;
  title: string;
  detail: string;
  payload: {
    transactionIds?: string[];
    transactionId?: string;
    merchant?: string;
    currentCategoryId?: string | null;
    currentCategoryName?: string | null;
    proposedCategoryId?: string | null;
    proposedCategoryName?: string | null;
    confidence?: number;
    evidence?: Record<string, unknown>;
    matchCounts?: {
      uncategorized: number;
      conflicts: number;
    };
  };
  createdAt: string;
  updatedAt: string;
}

/** Aggregate the dashboard hero card uses. */
export interface SpendSummary {
  /** Total outflow for the displayed period, as a positive number. */
  total: number;
  totalCents?: number;
  periodLabel: string;        // "MAY"
  deltaPct: number;           // +12 = up 12% vs prior period
  trailingMonths: number[];   // 0..1 normalized sparkline points
  trailingMonthLabels?: string[];
  trailingMonthCents?: number[];
  trailingMonthBusinessCents?: TrailingMonthBusinessSpend[][];
  lastMonth: number;
  lastMonthCents?: number;
  avgMonth: number;
  avgMonthCents?: number;
}

export interface TrailingMonthBusinessSpend {
  businessId: BusinessId;
  businessName: string;
  color: string;
  cents: number;
}

export interface CurrentUser {
  id: string;
  username: string;
  displayName: string;
  role: 'admin';
  totpEnabled: boolean;
}
