import type { Transaction } from '@/types/domain';
import { http, useMockApi } from './client';
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
