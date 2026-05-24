import type { BusinessId, ReceiptStatus, Transaction } from '@/types/domain';
import { http, useMockApi } from './client';
import { mapTransaction, type ApiTransaction } from './mapper';
import { TRANSACTIONS, visibleMockTransactions } from './mocks';

export interface ListTransactionsParams {
  biz?: BusinessId | 'all';
  /** ISO 8601 date, inclusive. */
  from?: string;
  /** ISO 8601 date, inclusive. */
  to?: string;
  /** Free-text search across merchant/category/note. */
  q?: string;
  limit?: number;
  accountIds?: string[];
  categories?: string[];
  receipts?: ReceiptStatus[];
  sort?: 'date' | 'amount' | 'merchant' | 'business' | 'category' | 'account';
  dir?: 'asc' | 'desc';
}

/**
 * GET /api/transactions?biz=&from=&to=&q=&limit=
 * Returns the most recent matching transactions, newest first.
 */
export function listTransactions(params: ListTransactionsParams = {}): Promise<Transaction[]> {
  if (useMockApi) {
    let rows = visibleMockTransactions(TRANSACTIONS, params.accountIds);
    if (params.biz && params.biz !== 'all') rows = rows.filter((t) => t.biz === params.biz);
    if (params.from) rows = rows.filter((t) => t.date >= params.from!);
    if (params.to) rows = rows.filter((t) => t.date <= params.to!);
    if (params.categories?.length) rows = rows.filter((t) => params.categories?.includes(t.cat));
    if (params.receipts?.length) rows = rows.filter((t) => params.receipts?.includes(t.receipt));
    if (params.q) {
      const q = params.q.toLowerCase();
      rows = rows.filter((t) => (
        t.merchant.toLowerCase().includes(q) ||
        t.cat.toLowerCase().includes(q) ||
        t.src.toLowerCase().includes(q) ||
        (t.note ?? '').toLowerCase().includes(q)
      ));
    }
    if (params.sort) rows.sort((a, b) => compareTransactions(a, b, params.sort ?? 'date', params.dir ?? 'desc'));
    if (params.limit) rows = rows.slice(0, params.limit);
    return Promise.resolve(rows);
  }
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || k === 'accountIds' || k === 'categories' || k === 'receipts') continue;
    query.set(k, String(v));
  }
  if (params.accountIds?.length) query.set('accounts', params.accountIds.join(','));
  if (params.categories?.length) query.set('categories', params.categories.join(','));
  if (params.receipts?.length) query.set('receipts', params.receipts.join(','));
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

export function updateTransaction(
  transactionId: string,
  body: { businessId?: string; categoryId?: string | null; note?: string | null },
): Promise<Transaction> {
  if (useMockApi) {
    const row = TRANSACTIONS.find((t) => t.id === transactionId);
    return Promise.resolve(row ? {
      ...row,
      ...body,
      note: body.note === null ? undefined : body.note ?? row.note,
    } : TRANSACTIONS[0]);
  }
  return http<ApiTransaction>(`/transactions/${transactionId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  }).then(mapTransaction);
}

function compareTransactions(
  a: Transaction,
  b: Transaction,
  sort: NonNullable<ListTransactionsParams['sort']>,
  dir: NonNullable<ListTransactionsParams['dir']>,
): number {
  const sign = dir === 'asc' ? 1 : -1;
  const av = valueForSort(a, sort);
  const bv = valueForSort(b, sort);
  if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sign;
  return String(av).localeCompare(String(bv)) * sign;
}

function valueForSort(transaction: Transaction, sort: NonNullable<ListTransactionsParams['sort']>): string | number {
  switch (sort) {
    case 'amount':
      return transaction.amount;
    case 'merchant':
      return transaction.merchant;
    case 'business':
      return transaction.biz;
    case 'category':
      return transaction.cat;
    case 'account':
      return transaction.src;
    default:
      return transaction.date;
  }
}
