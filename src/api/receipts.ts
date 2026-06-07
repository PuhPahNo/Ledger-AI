import type { BusinessId, ReceiptInboxItem, ReceiptMatchCandidate, ReceiptSource, ReceiptStatus, Transaction } from '@/types/domain';
import { API_BASE, ApiError, http, useMockApi } from './client';
import { mapTransaction, type ApiTransaction } from './mapper';

export interface UploadReceiptResult {
  receiptId: string;
  /** Backend's best guess for the transaction this receipt belongs to, if any. */
  matched?: Transaction;
  processing?: boolean;
  /** OCR result fields, if backend chooses to surface them. */
  ocr?: {
    merchant?: string;
    total?: number;
    date?: string;
  };
}

/**
 * POST /api/receipts (multipart/form-data with `file`)
 * Uploads a photo/PDF of a receipt; backend OCRs it and tries to match
 * the transaction. Returns the match suggestion so the UI can confirm.
 */
export function uploadReceipt(file: File, businessId?: string): Promise<UploadReceiptResult> {
  if (useMockApi) {
    return Promise.reject(new Error('uploadReceipt requires the real backend'));
  }
  const form = new FormData();
  form.append('file', file);
  if (businessId) form.append('businessId', businessId);
  return http<Omit<UploadReceiptResult, 'matched'> & { matched?: ApiTransaction }>('/receipts', {
    method: 'POST',
    body: form,
  }).then((result) => ({ ...result, matched: result.matched ? mapTransaction(result.matched) : undefined }));
}

export interface ListReceiptsParams {
  status?: ReceiptStatus;
  unmatched?: boolean;
  biz?: BusinessId | 'all';
  source?: ReceiptSource | 'all';
  q?: string;
  limit?: number;
}

export function listReceipts(params: ListReceiptsParams = {}): Promise<ReceiptInboxItem[]> {
  if (useMockApi) {
    const now = new Date().toISOString();
    const rows: ReceiptInboxItem[] = [
      {
        id: 'receipt-gmail-apple',
        biz: 'draft-sharks',
        businessName: 'Draft Sharks',
        source: 'gmail',
        status: 'pending',
        merchant: 'Apple Store',
        totalCents: 12900,
        receiptDate: '2026-05-22',
        fileName: 'Apple Store receipt.pdf',
        confidence: 0.91,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'receipt-upload-office-depot',
        biz: 'womens-net',
        businessName: 'Womens Net',
        source: 'upload',
        status: 'pending',
        merchant: 'Office Depot',
        totalCents: 8742,
        receiptDate: '2026-05-20',
        fileName: 'office-depot.jpg',
        confidence: 0.86,
        createdAt: now,
        updatedAt: now,
      },
    ];
    return Promise.resolve(rows.filter((row) => {
      if (params.status && row.status !== params.status) return false;
      if (params.biz && params.biz !== 'all' && row.biz !== params.biz) return false;
      if (params.source && params.source !== 'all' && row.source !== params.source) return false;
      if (params.q) {
        const q = params.q.toLowerCase();
        return [row.merchant, row.fileName, row.businessName].some((value) => value?.toLowerCase().includes(q));
      }
      return true;
    }));
  }
  const query = new URLSearchParams();
  if (params.status) query.set('status', params.status);
  if (params.unmatched) query.set('unmatched', 'true');
  if (params.biz && params.biz !== 'all') query.set('biz', params.biz);
  if (params.source && params.source !== 'all') query.set('source', params.source);
  if (params.q) query.set('q', params.q);
  if (params.limit) query.set('limit', String(params.limit));
  return http<ReceiptInboxItem[]>(`/receipts?${query.toString()}`);
}

export function getReceipt(receiptId: string): Promise<ReceiptInboxItem> {
  if (useMockApi) {
    return listReceipts().then((rows) => rows.find((row) => row.id === receiptId) ?? rows[0]);
  }
  return http<ReceiptInboxItem>(`/receipts/${receiptId}`);
}

export function listReceiptCandidates(receiptId: string): Promise<ReceiptMatchCandidate[]> {
  if (useMockApi) {
    return Promise.resolve(TRANSACTION_CANDIDATE_FIXTURES.map((transaction, index) => ({
      transaction: mapTransaction(transaction),
      score: index === 0 ? 0.91 : 0.62,
      reasons: index === 0
        ? { amountScore: 1, dateScore: 1, merchantScore: 0.72, cardScore: 0.5, businessScore: 1 }
        : { amountScore: 0.7, dateScore: 0.6, merchantScore: 0.2, cardScore: 0.5, businessScore: 0.7 },
      exactAmount: index === 0,
      ambiguous: false,
      suggested: index === 0,
      wouldAutoAttach: index === 0,
    })));
  }
  return http<Array<Omit<ReceiptMatchCandidate, 'transaction'> & { transaction: ApiTransaction }>>(
    `/receipts/${receiptId}/candidates`,
  ).then((rows) => rows.map((row) => ({ ...row, transaction: mapTransaction(row.transaction) })));
}

export interface UpdateReceiptInput {
  merchant?: string | null;
  totalCents?: number | null;
  receiptDate?: string | null;
}

export function updateReceipt(receiptId: string, body: UpdateReceiptInput): Promise<ReceiptInboxItem> {
  if (useMockApi) {
    return listReceipts().then((rows) => ({
      ...(rows.find((row) => row.id === receiptId) ?? rows[0]),
      ...body,
      updatedAt: new Date().toISOString(),
    }));
  }
  return http<ReceiptInboxItem>(`/receipts/${receiptId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export function receiptFileUrl(receiptId: string, options: { download?: boolean } = {}): string {
  const query = options.download ? '?download=true' : '';
  return `${API_BASE.replace(/\/$/, '')}/receipts/${encodeURIComponent(receiptId)}/file${query}`;
}

export async function fetchReceiptFileText(receiptId: string): Promise<string> {
  if (useMockApi) return 'Mock receipt preview\n\nTotal: $129.00\nDate: 2026-05-22';
  const res = await fetch(receiptFileUrl(receiptId), { credentials: 'include' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ApiError(res.status, body || `GET /receipts/${receiptId}/file -> ${res.status}`, body);
  }
  return res.text();
}

export function dismissReceipt(receiptId: string): Promise<{ ok: true }> {
  if (useMockApi) return Promise.resolve({ ok: true });
  return http<{ ok: true }>(`/receipts/${receiptId}/dismiss`, { method: 'POST' });
}

const TRANSACTION_CANDIDATE_FIXTURES: ApiTransaction[] = [
  {
    id: 'mock-candidate-1',
    businessId: 'draft-sharks',
    accountId: 'mock-account',
    categoryId: null,
    receiptId: null,
    date: '2026-05-22',
    merchant: 'Apple Store',
    amountCents: -12900,
    biz: 'draft-sharks',
    cat: 'Software',
    receipt: 'missing',
    src: 'Amex •• 4002',
  } as ApiTransaction,
  {
    id: 'mock-candidate-2',
    businessId: 'draft-sharks',
    accountId: 'mock-account',
    categoryId: null,
    receiptId: null,
    date: '2026-05-24',
    merchant: 'Apple Services',
    amountCents: -9900,
    biz: 'draft-sharks',
    cat: 'Software',
    receipt: 'missing',
    src: 'Amex •• 4002',
  } as ApiTransaction,
];
