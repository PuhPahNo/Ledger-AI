import type { BusinessId, Transaction } from '@/types/domain';
import { http, useMockApi } from './client';
import { mapTransaction, type ApiTransaction } from './mapper';
import { TRANSACTIONS } from './mocks';

export interface ListTransactionsParams {
  biz?: BusinessId | 'all';
  /** ISO 8601 date, inclusive. */
  from?: string;
  /** ISO 8601 date, inclusive. */
  to?: string;
  /** Free-text search across merchant/category/note. */
  q?: string;
  limit?: number;
}

/**
 * GET /api/transactions?biz=&from=&to=&q=&limit=
 * Returns the most recent matching transactions, newest first.
 */
export function listTransactions(params: ListTransactionsParams = {}): Promise<Transaction[]> {
  if (useMockApi) {
    let rows = [...TRANSACTIONS];
    if (params.biz && params.biz !== 'all') rows = rows.filter((t) => t.biz === params.biz);
    if (params.q) {
      const q = params.q.toLowerCase();
      rows = rows.filter((t) => t.merchant.toLowerCase().includes(q) || t.cat.toLowerCase().includes(q));
    }
    if (params.limit) rows = rows.slice(0, params.limit);
    return Promise.resolve(rows);
  }
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null) query.set(k, String(v));
  return http<ApiTransaction[]>(`/transactions?${query.toString()}`).then((rows) => rows.map(mapTransaction));
}

/**
 * POST /api/transactions/:id/receipt
 * Attach an uploaded receipt to an existing transaction.
 */
export function attachReceipt(transactionId: string, receiptId: string): Promise<Transaction> {
  if (useMockApi) {
    return Promise.reject(new Error('attachReceipt is not implemented in the mock backend'));
  }
  return http<ApiTransaction>(`/transactions/${transactionId}/receipt`, {
    method: 'POST',
    body: JSON.stringify({ receiptId }),
  }).then(mapTransaction);
}
