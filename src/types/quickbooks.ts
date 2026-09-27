// QuickBooks Online (read-only) API shapes. Mirrors server/routes/quickbooks.ts.

export type QboConnectionStatus = 'live' | 'reauth' | 'disconnected';
export type QboEntityType = 'Purchase' | 'BillPayment' | 'Bill' | 'Deposit' | 'Transfer' | 'VendorCredit';
export type QboPaymentMethod = 'check' | 'credit_card' | 'cash_ach' | 'deposit' | 'transfer' | 'bill' | 'vendor_credit';
export type QboLeg = 'main' | 'from' | 'to';
export type QboMappingMethod = 'auto' | 'manual' | null;
export type QboAttachmentImportStatus = 'pending' | 'imported' | 'duplicate' | 'skipped' | 'failed';

export interface QboConnectionCounts {
  accounts: number;
  vendors: number;
  transactions: number;
  linked: number;
  attachments: number;
  unmappedBankAccounts: number;
}

export interface QboConnectionSummary {
  id: string;
  status: QboConnectionStatus;
  companyName: string | null;
  realmId: string;
  environment: string;
  lastSyncAt: string | null;
  lastFullSyncAt: string | null;
  lastSyncError: string | null;
  historyStartDate: string | null;
  syncing: boolean;
  counts: QboConnectionCounts;
}

export interface QboBusinessStatus {
  businessId: string;
  businessKey: string;
  businessName: string;
  connection: QboConnectionSummary | null;
}

export interface QboStatus {
  /** False when the server has no QuickBooks credentials — show "not configured". */
  configured: boolean;
  environment: 'sandbox' | 'production' | null;
  businesses: QboBusinessStatus[];
}

export interface QboAccountRef {
  id: string;
  qboId: string;
  name: string;
  fullyQualifiedName: string | null;
  accountType: string | null;
  accountSubType: string | null;
  acctNumLast4: string | null;
  active: boolean;
}

export interface QboBankAccountMapping {
  qboAccount: QboAccountRef;
  ledgerAccountId: string | null;
  method: QboMappingMethod;
  suggestions: Array<{ ledgerAccountId: string; name: string; mask: string | null; reason: 'last4' }>;
}

export interface QboExpenseAccountMapping {
  qboAccount: QboAccountRef;
  categoryId: string | null;
  categoryName: string | null;
  method: QboMappingMethod;
  score: number | null;
  suggestion: { categoryId: string; name: string; score: number } | null;
  contractLabor: boolean;
}

export interface QboMappings {
  connectionId: string;
  businessId: string;
  bankAccounts: QboBankAccountMapping[];
  expenseAccounts: QboExpenseAccountMapping[];
  ledgerAccounts: Array<{ id: string; name: string; mask: string | null; kind: string }>;
  categories: Array<{ id: string; name: string }>;
}

export interface QboMappingsUpdate {
  bankAccounts?: Array<{ qboAccountId: string; ledgerAccountId: string | null }>;
  expenseAccounts?: Array<{ qboAccountId: string; categoryId: string | null }>;
}

export type QboContractorReason = 'vendor_1099' | 'contract_labor_account';

export interface QboContractorPayment {
  qboTransactionId: string;
  entityType: QboEntityType;
  vendorQboId: string;
  txnDate: string;
  amountCents: number;
  method: QboPaymentMethod | null;
  memo: string | null;
  docNumber: string | null;
  linkedTransactionId: string | null;
  ledgerReceiptStatus: string | null;
  qboAttachmentCount: number;
  /** 'matched' | 'attached_in_quickbooks' | Ledger receipt status | 'none' */
  receiptStatus: string;
}

export interface QboContractor {
  vendorQboId: string;
  name: string;
  reasons: QboContractorReason[];
  vendor1099: boolean;
  taxIdOnFile: boolean;
  periodPaidCents: number;
  periodPaymentCount: number;
  ytdPaidCents: number;
  /** YTD excluding card payments (those go on the processor's 1099-K). */
  ytdReportableCents: number;
  lastPaidDate: string | null;
  paymentMethods: string[];
  threshold: { year: number; cents: number; exact: boolean; meetsThreshold: boolean };
  payments: QboContractorPayment[];
}

export interface QboContractorsReport {
  from: string;
  to: string;
  threshold: { year: number; cents: number; exact: boolean; guidance: string };
  companies: Array<{ connectionId: string; businessId: string; companyName: string | null; contractors: QboContractor[] }>;
}

export interface QboTransactionSummary {
  id: string;
  connectionId: string;
  entityType: QboEntityType;
  qboId: string;
  txnDate: string;
  totalCents: number;
  paymentMethod: QboPaymentMethod | null;
  docNumber: string | null;
  memo: string | null;
  payeeName: string | null;
  vendorQboId: string | null;
  bankAccountName: string | null;
  legs: Array<{ leg: QboLeg; accountQboId: string; amountCents: number }>;
  deleted: boolean;
}

export interface QboCategorySuggestion {
  transactionId: string;
  categoryId: string;
  source: 'quickbooks';
  confidence: number;
  evidence: {
    qboAccount: { qboId: string; name: string };
    vendor: { qboId: string; name: string } | null;
    qboTransactionId: string;
    entityType: string;
    mappingMethod: QboMappingMethod;
    lineShare: number;
  };
}

export interface QboTransactionLink {
  linkId: string;
  leg: QboLeg;
  method: 'auto' | 'manual';
  confidence: number | null;
  reasons: Record<string, unknown>;
  qboTransaction: QboTransactionSummary;
  vendor: { qboId: string; name: string; vendor1099: boolean; taxIdOnFile: boolean } | null;
  expenseAccounts: Array<{
    qboAccountId: string | null;
    name: string | null;
    amountCents: number;
    description: string | null;
    categoryId: string | null;
    categoryName: string | null;
  }>;
  attachments: Array<{ id: string; fileName: string | null; contentType: string | null; importStatus: QboAttachmentImportStatus; receiptId: string | null }>;
  isContractor: boolean;
}

/** GET /transactions/:id/quickbooks — drawer panel. `candidates` only when nothing is linked. */
export interface QboTransactionDetails {
  transactionId: string;
  links: QboTransactionLink[];
  categorySuggestion: QboCategorySuggestion | null;
  candidates: QboTransactionSummary[];
}
