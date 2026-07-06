import type {
  Alert,
  Business,
  Category,
  CategorizationReviewItem,
  Connection,
  Receipt,
  Transaction,
} from '../db/schema.js';

export function toApiBusiness(row: Business) {
  return {
    id: row.key,
    dbId: row.id,
    name: row.name,
    short: row.short,
    color: row.color,
    hue: row.hue,
    active: row.active,
  };
}

export interface ApiConnectionHealth {
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

export function toApiConnection(row: Connection, businessKey?: string, health?: ApiConnectionHealth) {
  return {
    id: row.id,
    businessId: row.businessId,
    kind: row.kind,
    label: row.label,
    mask: row.mask ? `•• ${row.mask.replace(/^••\s*/, '')}` : undefined,
    status: row.status,
    last: row.lastSyncAt ? row.lastSyncAt.toISOString() : 'never',
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    txns: row.syncedTransactionCount,
    biz: businessKey ?? 'all',
    health,
  };
}

export function toApiTransaction(row: Transaction & {
  businessKey?: string;
  categoryName?: string | null;
  categoryTaxCode?: string | null;
}) {
  return {
    id: row.id,
    businessId: row.businessId,
    accountId: row.accountId,
    categoryId: row.categoryId,
    receiptId: row.receiptId,
    date: row.date,
    merchant: row.merchant,
    amountCents: row.amountCents,
    biz: row.businessKey ?? row.businessId,
    cat: row.categoryName ?? 'Uncategorized',
    categoryTaxCode: row.categoryTaxCode ?? undefined,
    categorySource: row.categorySource,
    categoryConfidence: row.categoryConfidence == null ? undefined : Number(row.categoryConfidence),
    categoryEvidence: row.categoryEvidence,
    receipt: row.receiptStatus,
    src: row.sourceLabel,
    note: row.note ?? undefined,
    flag: row.flag ?? undefined,
    pending: row.pending,
  };
}

export function toApiReceipt(row: Receipt & {
  businessKey?: string | null;
  businessName?: string | null;
  uploadedByUserName?: string | null;
  uploadedByUploaderName?: string | null;
}) {
  return {
    id: row.id,
    businessId: row.businessId,
    biz: row.businessKey ?? 'all',
    businessName: row.businessName ?? null,
    source: row.source,
    status: row.status,
    merchant: row.merchant,
    totalCents: row.totalCents,
    receiptDate: row.receiptDate,
    fileName: row.fileName,
    mimeType: row.mimeType,
    gmailMessageId: row.gmailMessageId,
    transactionId: row.transactionId,
    uploadedByUserId: row.uploadedByUserId,
    uploadedByUploaderId: row.uploadedByUploaderId,
    uploadedBy: row.uploadedByUploaderName ?? row.uploadedByUserName ?? null,
    confidence: row.confidence == null ? null : Number(row.confidence),
    extractionError: row.extractionError ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toApiCategory(row: Category & { amountCents?: number; count?: number; delta?: string }) {
  return {
    id: row.id,
    name: row.name,
    taxCode: row.taxCode,
    amountCents: row.amountCents ?? 0,
    delta: row.delta ?? '+0%',
    count: row.count ?? 0,
  };
}

export function toApiAlert(row: Alert) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    detail: row.detail,
    severity: row.severity,
    status: row.status,
  };
}

export function toApiCategorizationReviewItem(row: CategorizationReviewItem & { businessKey?: string | null }) {
  return {
    id: row.id,
    businessId: row.businessId,
    biz: row.businessKey ?? row.businessId,
    type: row.type,
    status: row.status,
    title: row.title,
    detail: row.detail,
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
