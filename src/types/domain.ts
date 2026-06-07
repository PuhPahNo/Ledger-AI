// Single source of truth for the shapes the UI consumes.
// The API layer is responsible for mapping backend responses to these types,
// so the UI never has to care about Plaid / Gmail / Stripe wire formats.

import type { AppViewName } from './assistant';
export type {
  AppViewName,
  AssistantApprovalRequest,
  AssistantArtifact,
  AssistantArtifactAction,
  AssistantArtifactSource,
  AssistantMetric,
  AssistantResponse,
  AssistantTone,
  AssistantToolEvent,
} from './assistant';

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
  | 'n/a'       // inflow / non-receiptable
  | 'waived';   // intentionally not expected (e.g. spend before receipt tracking began)

export type ReceiptSource = 'upload' | 'gmail';

export interface ReceiptInboxItem {
  id: string;
  businessId?: string | null;
  biz: BusinessId | 'all';
  businessName?: string | null;
  source: ReceiptSource;
  status: ReceiptStatus;
  merchant?: string | null;
  totalCents?: number | null;
  receiptDate?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  gmailMessageId?: string | null;
  transactionId?: string | null;
  uploadedByUserId?: string | null;
  uploadedByUploaderId?: string | null;
  uploadedBy?: string | null;
  confidence?: number | null;
  createdAt: string;
  updatedAt: string;
  downloadUrl?: string | null;
}

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
  /** Gross positive cash (includes incoming transfers). */
  inflowCents: number;
  /** Gross negative cash (includes outgoing transfers). */
  outflowCents: number;
  /** Inflow excluding incoming transfers — real money in. */
  operatingInflowCents: number;
  /** Outflow excluding outgoing transfers — real money out. */
  operatingOutflowCents: number;
  /** Total |transfer movement| in both directions. */
  transferCents: number;
  /** Sum of all amounts (positive - negative, including transfers). */
  netCents: number;
  missingReceipts: number;
}

export type CashFlowGroup = 'month' | 'year';

export interface CashFlowBusinessBreakdown {
  businessId: BusinessId;
  businessName: string;
  color: string;
  inflowCents: number;
  outflowCents: number;
  transferCents: number;
  netCents: number;
  /** Net for the same period one year earlier (for per-business YoY). */
  previousNetCents: number;
}

export interface CashFlowPeriod {
  label: string;
  from: string;
  to: string;
  inflowCents: number;
  outflowCents: number;
  transferCents: number;
  netCents: number;
  previousInflowCents: number;
  previousOutflowCents: number;
  previousTransferCents: number;
  previousNetCents: number;
  netDeltaCents: number;
  netDeltaPct: number;
  businessBreakdown: CashFlowBusinessBreakdown[];
}

export interface CashFlowSummary {
  from: string;
  to: string;
  group: CashFlowGroup;
  includeTransfers: boolean;
  totals: Omit<CashFlowPeriod, 'label' | 'from' | 'to' | 'businessBreakdown'>;
  periods: CashFlowPeriod[];
}

export interface OwnerInsightMetric {
  count: number;
  cents: number;
}

export interface OwnerIncomeByBusiness {
  businessId: BusinessId;
  businessName: string;
  color: string;
  cents: number;
  count: number;
}

export interface OwnerCloseSummary {
  inflowCents: number;
  outflowCents: number;
  netCents: number;
  transactionCount: number;
}

export interface OwnerInsightsSummary {
  from: string;
  to: string;
  topPurchases: Transaction[];
  uncategorized: OwnerInsightMetric;
  missingReceipts: OwnerInsightMetric;
  transfers: OwnerInsightMetric;
  incomeByBusiness: OwnerIncomeByBusiness[];
  closeSummary: OwnerCloseSummary;
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
  health?: ConnectionHealth;
}

export interface ConnectionHealth {
  lastSyncAt: string | null;
  lastWebhookAt: string | null;
  lastPubSubAt: string | null;
  gmailWatchExpiration: string | null;
  gmailWatchRenewalDue: boolean;
  lastJobType: string | null;
  lastJobStatus: string | null;
  lastJobAt: string | null;
  lastJobError: string | null;
  queuedJobCount: number;
  failedJobCount: number;
  actions: {
    canSync: boolean;
    canBackfill: boolean;
    gmailBackfillDays: number[];
    plaidBackfillMonths: number[];
  };
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
  connectionLastSyncAt?: string | null;
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
    proposedRule?: {
      matchKind: string;
      pattern: string;
      priority: number;
    };
  };
  createdAt: string;
  updatedAt: string;
}

export type FlowBucketGranularity = 'day' | 'week' | 'month';

export interface FlowBucket {
  label: string;
  from: string;
  to: string;
  inflowCents: number;
  outflowCents: number;
  netCents: number;
  inflowBusinessCents: TrailingMonthBusinessSpend[];
  outflowBusinessCents: TrailingMonthBusinessSpend[];
}

/** Aggregate the dashboard hero card uses. */
export interface SpendSummary {
  /** Total outflow for the displayed period, as a positive number. */
  total: number;
  totalCents?: number;
  inflow?: number;
  inflowCents?: number;
  outflow?: number;
  outflowCents?: number;
  net?: number;
  netCents?: number;
  periodLabel: string;        // "MAY"
  deltaPct: number;           // +12 = up 12% vs prior period
  inflowDeltaPct?: number;
  outflowDeltaPct?: number;
  netDeltaPct?: number;
  bucketGranularity?: FlowBucketGranularity;
  flowBuckets?: FlowBucket[];
  trailingMonths: number[];   // 0..1 normalized sparkline points
  trailingMonthLabels?: string[];
  trailingMonthCents?: number[];
  trailingMonthBusinessCents?: TrailingMonthBusinessSpend[][];
  trailingInflowMonthCents?: number[];
  trailingOutflowMonthCents?: number[];
  trailingNetMonthCents?: number[];
  trailingInflowBusinessCents?: TrailingMonthBusinessSpend[][];
  trailingOutflowBusinessCents?: TrailingMonthBusinessSpend[][];
  lastMonth: number;
  lastMonthCents?: number;
  lastInflow?: number;
  lastInflowCents?: number;
  lastOutflow?: number;
  lastOutflowCents?: number;
  lastNet?: number;
  lastNetCents?: number;
  avgMonth: number;
  avgMonthCents?: number;
  avgInflow?: number;
  avgInflowCents?: number;
  avgOutflow?: number;
  avgOutflowCents?: number;
  avgNet?: number;
  avgNetCents?: number;
}

export interface TrailingMonthBusinessSpend {
  businessId: BusinessId;
  businessName: string;
  color: string;
  cents: number;
}

export interface ReceiptMatchCandidate {
  transaction: Transaction;
  score: number;
  reasons: Record<string, number | string>;
  exactAmount: boolean;
  ambiguous: boolean;
  suggested: boolean;
  wouldAutoAttach: boolean;
}

export type CloseReadinessSeverity = 'blocker' | 'review' | 'ready';

export interface CloseReadinessItem {
  id: string;
  label: string;
  detail: string;
  severity: CloseReadinessSeverity;
  count: number;
  cents?: number;
  actionView: AppViewName;
  filters?: Record<string, string | string[] | boolean | null>;
}

export interface CloseReadiness {
  from: string;
  to: string;
  biz: BusinessId | 'all';
  signedOff: boolean;
  signedOffAt?: string | null;
  canSignOff: boolean;
  items: CloseReadinessItem[];
}

export interface CurrentUser {
  id: string;
  username: string;
  displayName: string;
  role: 'admin';
  totpEnabled: boolean;
}
