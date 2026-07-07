import type { BusinessId, ReceiptStatus, Transaction, TransactionDirection, TransactionRollup } from '@/types/domain';
import { http, useMockApi } from './client';
import { mapTransaction, type ApiTransaction } from './mapper';
import { TRANSACTIONS, visibleMockTransactions } from './mocks';
import { summarizeTransactions, transactionMatchesDirection } from '@/lib/calc';

export interface ListTransactionsParams {
  biz?: BusinessId | 'all';
  /** ISO 8601 date, inclusive. */
  from?: string;
  /** ISO 8601 date, inclusive. */
  to?: string;
  /** Free-text search across merchant/category/note. */
  q?: string;
  limit?: number;
  offset?: number;
  accountIds?: string[];
  categories?: string[];
  receipts?: ReceiptStatus[];
  /** Tag ids — transactions carrying ANY of these tags. */
  tagIds?: string[];
  direction?: TransactionDirection;
  sort?: 'date' | 'amount' | 'largest' | 'merchant' | 'business' | 'category' | 'account';
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
    if (params.tagIds?.length) rows = rows.filter((t) => t.tags?.some((tag) => params.tagIds?.includes(tag.id)));
    if (params.direction && params.direction !== 'all') {
      rows = rows.filter((t) => transactionMatchesDirection(t, params.direction ?? 'all'));
    }
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
    if (params.offset) rows = rows.slice(params.offset);
    if (params.limit) rows = rows.slice(0, params.limit);
    return Promise.resolve(rows);
  }
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || k === 'accountIds' || k === 'categories' || k === 'receipts' || k === 'tagIds') continue;
    query.set(k, String(v));
  }
  if (params.accountIds?.length) query.set('accounts', params.accountIds.join(','));
  if (params.categories?.length) query.set('categories', params.categories.join(','));
  if (params.receipts?.length) query.set('receipts', params.receipts.join(','));
  if (params.tagIds?.length) query.set('tags', params.tagIds.join(','));
  return http<ApiTransaction[]>(`/transactions?${query.toString()}`).then((rows) => rows.map(mapTransaction));
}

export function getTransactionRollup(params: Omit<ListTransactionsParams, 'limit' | 'offset' | 'sort' | 'dir'> = {}): Promise<TransactionRollup> {
  if (useMockApi) {
    return listTransactions({ ...params, limit: undefined, offset: undefined }).then(summarizeTransactions);
  }
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || k === 'accountIds' || k === 'categories' || k === 'receipts' || k === 'tagIds') continue;
    query.set(k, String(v));
  }
  if (params.accountIds?.length) query.set('accounts', params.accountIds.join(','));
  if (params.categories?.length) query.set('categories', params.categories.join(','));
  if (params.receipts?.length) query.set('receipts', params.receipts.join(','));
  if (params.tagIds?.length) query.set('tags', params.tagIds.join(','));
  return http<TransactionRollup>(`/transactions/rollup?${query.toString()}`);
}

/**
 * POST /api/transactions/:id/receipt
 * Attach an uploaded receipt to an existing transaction.
 */
export function attachReceipt(transactionId: string, receiptId: string): Promise<Transaction> {
  if (useMockApi) {
    const row = TRANSACTIONS.find((transaction) => transaction.id === transactionId) ?? TRANSACTIONS[0];
    return Promise.resolve({ ...row, receiptId, receipt: 'matched' });
  }
  return http<ApiTransaction>(`/transactions/${transactionId}/receipt`, {
    method: 'POST',
    body: JSON.stringify({ receiptId }),
  }).then(mapTransaction);
}

/**
 * POST /api/transactions/bulk-category — manually categorize many transactions at once.
 * Direction-mismatched rows are skipped server-side; learning fires once per merchant.
 */
export function bulkCategorizeTransactions(
  transactionIds: string[],
  categoryId: string,
): Promise<{ updated: number; skipped: number }> {
  if (useMockApi) return Promise.resolve({ updated: transactionIds.length, skipped: 0 });
  return http<{ updated: number; skipped: number }>('/transactions/bulk-category', {
    method: 'POST',
    body: JSON.stringify({ transactionIds, categoryId }),
  });
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

export interface ReceiptTracking {
  since: string | null;
  waivable: number;
}

/** Current receipt-tracking cutoff, plus how many missing receipts predate `before` (if given). */
export function getReceiptTracking(before?: string): Promise<ReceiptTracking> {
  if (useMockApi) {
    const waivable = before
      ? TRANSACTIONS.filter((t) => t.receipt === 'missing' && t.date < before).length
      : 0;
    return Promise.resolve({ since: null, waivable });
  }
  const query = before ? `?before=${encodeURIComponent(before)}` : '';
  return http<ReceiptTracking>(`/transactions/receipt-tracking${query}`);
}

/** Bulk-mark missing receipts dated before `before` as waived, and set the tracking cutoff. */
export function waiveMissingReceipts(before: string): Promise<{ waived: number; since: string }> {
  if (useMockApi) {
    const waived = TRANSACTIONS.filter((t) => t.receipt === 'missing' && t.date < before).length;
    return Promise.resolve({ waived, since: before });
  }
  return http<{ waived: number; since: string }>('/transactions/waive-missing', {
    method: 'POST',
    body: JSON.stringify({ before }),
  });
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
    case 'largest':
      return Math.abs(transaction.amount);
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
