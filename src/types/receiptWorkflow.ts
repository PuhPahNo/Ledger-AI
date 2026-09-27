// Receipt workflow types: match queue, recently matched, counts, "no receipt needed" rules, and
// per-transaction missing-receipt actions. Server shapes live in server/routes/receiptWorkflow.ts.
import type { BusinessId, ReceiptInboxItem, Transaction } from './domain';

export type MatchReasonKind = 'amount' | 'date' | 'merchant' | 'card' | 'business';
export type MatchReasonStrength = 'strong' | 'good' | 'weak' | 'conflict';

/** One human-readable line explaining a pairing, e.g. { kind: 'amount', text: 'Amount exact' }. */
export interface MatchReason {
  kind: MatchReasonKind;
  text: string;
  strength: MatchReasonStrength;
  /** Underlying 0–1 component score. */
  score: number;
}

/** A transaction a receipt could belong to, with the matcher's verdict and reasons. */
export interface ExplainedMatchCandidate {
  transaction: Transaction;
  score: number;
  /** Raw scorer components (amountScore, dateScore, …). */
  reasons: Record<string, number | string>;
  explanations: MatchReason[];
  exactAmount: boolean;
  ambiguous: boolean;
  suggested: boolean;
  wouldAutoAttach: boolean;
  /** The user already rejected this pair. */
  rejected: boolean;
}

/** Receipt sources: 'quickbooks' arrives with the QuickBooks integration. */
export type ReceiptWorkflowSource = 'upload' | 'gmail' | 'quickbooks';

/**
 * 'missing_details': no total/date could be read — ask the user to type them.
 * 'extraction_pending': the file is still being read.
 */
export type QueueBlockedReason = 'missing_details' | 'extraction_pending' | null;

export interface MatchQueueItem {
  receipt: ReceiptInboxItem;
  /** Top (≤3) candidates for the 1/2/3 keys; empty when blocked. */
  candidates: ExplainedMatchCandidate[];
  blockedReason: QueueBlockedReason;
}

export interface MatchQueuePage {
  items: MatchQueueItem[];
  /** Receipts left in the queue (excluding skipped ones). */
  total: number;
  nextOffset: number | null;
}

export interface MatchQueueParams {
  limit?: number;
  offset?: number;
  /** Receipt ids skipped this session (S key) so they don't come straight back. */
  skip?: string[];
  biz?: BusinessId | 'all';
  order?: 'newest' | 'oldest';
}

/** Result of a queue action: what changed plus the next item so the UI can advance. */
export interface MatchQueueStep {
  receipt: ReceiptInboxItem | null;
  transaction?: Transaction | null;
  next: MatchQueueItem | null;
  remaining: number;
}

export type RecentMatchMode = 'auto' | 'manual';

export interface RecentMatch {
  matchId: string;
  mode: RecentMatchMode;
  matchedAt: string | null;
  score: number;
  receipt: ReceiptInboxItem;
  transaction: Transaction;
  explanations: MatchReason[];
}

export interface RecentMatchesParams {
  days?: number;
  mode?: RecentMatchMode | 'all';
  limit?: number;
  offset?: number;
  biz?: BusinessId | 'all';
}

export interface ReceiptWorkflowCounts {
  unmatchedReceipts: number;
  /** Operating outflow still missing a receipt (same definition as the close queue / Inbox). */
  missingReceipts: { count: number; cents: number };
  waivedThisMonth: { count: number; cents: number };
  autoMatchedThisWeek: number;
}

export type ReceiptWaiverRuleKind = 'threshold' | 'merchant' | 'category';

export interface ReceiptWaiverRule {
  id: string;
  kind: ReceiptWaiverRuleKind;
  enabled: boolean;
  /** e.g. 'Under $75.00 (lodging excluded)', 'Merchant: Adobe', 'Category: Software'. */
  label: string;
  businessId: string | null;
  thresholdCents: number | null;
  excludeLodging: boolean;
  merchantPattern: string | null;
  merchantLabel: string | null;
  categoryId: string | null;
  categoryName: string | null;
  note: string | null;
  /** Transactions this rule currently keeps waived (what "delete and reopen" would re-open). */
  waivedCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ThresholdRuleInput {
  enabled: boolean;
  thresholdCents?: number;
  excludeLodging?: boolean;
}

export type CreateWaiverRuleInput =
  | { kind: 'merchant'; merchant: string; businessId?: string | null; note?: string | null; applyToExisting?: boolean }
  | { kind: 'category'; categoryId: string; note?: string | null; applyToExisting?: boolean };

export interface CreateWaiverRuleResult {
  rule: ReceiptWaiverRule;
  created: boolean;
  /** Existing missing-receipt transactions waived by `applyToExisting`. */
  waived: number;
}

export interface WaiverApplyPreview {
  count: number;
  totalCents: number;
  byRule: Array<{ ruleId: string; kind: ReceiptWaiverRuleKind; label: string; count: number; totalCents: number }>;
  sampleTransactionIds: string[];
}

export type WaiverEvidenceKind = ReceiptWaiverRuleKind | 'manual' | 'tracking_cutoff' | 'unknown';

export interface WaiverEvidence {
  kind: WaiverEvidenceKind;
  ruleId: string | null;
  label: string;
  note: string | null;
  createdAt: string | null;
}

export interface WaiveTransactionInput {
  /** Also create a merchant rule so this merchant never needs a receipt. */
  alwaysForMerchant?: boolean;
  /** Scope that merchant rule to this transaction's business only. */
  thisBusinessOnly?: boolean;
  note?: string | null;
}

export interface WaiveTransactionResult {
  transaction: Transaction | null;
  rule: ReceiptWaiverRule | null;
  /** Other missing transactions the new merchant rule waived. */
  alsoWaived: number;
}

export interface UploadToTransactionResult {
  transaction: Transaction | null;
  receipt: ReceiptInboxItem | null;
  /** True while the new file is being read (details fill in shortly). */
  processing: boolean;
}

export type GmailHitStatus = 'paired_here' | 'paired_elsewhere' | 'candidate' | 'processing' | 'needs_details' | 'dismissed';

export interface GmailHit {
  receipt: ReceiptInboxItem;
  status: GmailHitStatus;
  isNew: boolean;
  score: number | null;
  explanations: MatchReason[];
}

export interface FindInGmailResult {
  search: {
    query: string;
    merchantTerms: string[];
    amountVariants: string[];
    from: string;
    to: string;
  };
  /** False when the merchant/amount gave nothing to search for. */
  searchable: boolean;
  mailboxes: Array<{ connectionId: string; email: string | null; messagesFound: number; newReceipts: number; error: string | null }>;
  hits: GmailHit[];
  /** The transaction now has a receipt. */
  paired: boolean;
  transaction: Transaction;
}
