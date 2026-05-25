import { http, useMockApi } from './client';

export interface ReceiptUploaderSessionUser {
  id: string;
  username: string;
  displayName: string;
  accountType?: 'receipt_uploader' | 'admin';
  businessId?: string | null;
  businessName?: string | null;
}

export type ReceiptUploadLoginResult =
  | { uploader: ReceiptUploaderSessionUser }
  | { requiresTotp: true };

export interface EmployeeReceiptUploadResult {
  receiptId: string;
  duplicate: boolean;
  processing: boolean;
  message?: string;
}

export function getReceiptUploaderSession(): Promise<{ uploader: ReceiptUploaderSessionUser | null }> {
  if (useMockApi) {
    return Promise.resolve({
      uploader: {
        id: 'mock-uploader',
        username: 'employee',
        displayName: 'Receipt Uploader',
        accountType: 'receipt_uploader',
        businessName: 'Demo Business',
      },
    });
  }
  return http<{ uploader: ReceiptUploaderSessionUser | null }>('/receipt-upload/me');
}

export function loginReceiptUploader(username: string, password: string, totpCode?: string): Promise<ReceiptUploadLoginResult> {
  if (useMockApi) {
    return Promise.resolve({
      uploader: {
        id: 'mock-uploader',
        username,
        displayName: username || 'Receipt Uploader',
        accountType: 'receipt_uploader',
        businessName: 'Demo Business',
      },
    });
  }
  return http<ReceiptUploadLoginResult>('/receipt-upload/login', {
    method: 'POST',
    body: JSON.stringify({ username, password, totpCode }),
  });
}

export function logoutReceiptUploader(): Promise<{ ok: true }> {
  if (useMockApi) return Promise.resolve({ ok: true });
  return http<{ ok: true }>('/receipt-upload/logout', { method: 'POST' });
}

export function uploadEmployeeReceipt(file: File): Promise<EmployeeReceiptUploadResult> {
  if (useMockApi) {
    return Promise.resolve({
      receiptId: crypto.randomUUID(),
      duplicate: false,
      processing: true,
    });
  }
  const form = new FormData();
  form.append('file', file);
  return http<EmployeeReceiptUploadResult>('/receipt-upload/receipts', {
    method: 'POST',
    body: form,
  });
}
