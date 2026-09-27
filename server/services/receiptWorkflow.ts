import { and, desc, eq, getTableColumns, gte, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  accounts,
  businesses,
  categories,
  connections,
  receiptMatches,
  receipts,
  transactions,
  type Receipt,
  type Transaction,
} from '../db/schema.js';
import { enqueue } from '../jobs/queue.js';
import { accountSpendFilter, categoryIsVisibleSpend } from '../routes/dashboard/helpers.js';
import { isGmailAuthError, searchGmailAndIngest } from './gmail.js';
import { buildTransactionGmailQuery, type TransactionGmailQuery } from './gmailReceiptIntake.js';
import type { MatchReason } from './matchReasons.js';
import {
  explainReceiptMatch,
  matchReceipt,
  receiptMatchCandidates,
  receiptMatchSkipReason,
  scoreMatch,
  type ReceiptMatchCandidate,
} from './matching.js';
import { extractAndMatchReceipt } from './receiptProcessing.js';

// ---------------------------------------------------------------------------------------------
// Pure shaping
// ---------------------------------------------------------------------------------------------

export const QUEUE_CANDIDATE_LIMIT = 3;

export type QueueBlockedReason = 'missing_details' | 'extraction_pending' | null;

/**
 * Why a queued receipt can't be paired from its candidates yet: no total/date (extraction failed or
 * is still running) means there's nothing to score against, so the UI should ask for details.
 */
export function queueBlockedReason(receipt: Pick<Receipt, 'totalCents' | 'receiptDate' | 'extractionError' | 'confidence'>): QueueBlockedReason {
  if (receipt.totalCents && receipt.receiptDate) return null;
  if (!receipt.extractionError && receipt.confidence == null) return 'extraction_pending';
  return 'missing_details';
}

/**
 * The candidates a queue row offers for the 1/2/3 keys: best-scoring first, pairs the user already
 * rejected removed, at most `limit`.
 */
export function shapeQueueCandidates<T extends { score: number; rejected: boolean }>(
  candidates: T[],
  limit = QUEUE_CANDIDATE_LIMIT,
): T[] {
  return candidates
    .filter((candidate) => !candidate.rejected)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export type RecentMatchMode = 'auto' | 'manual';

export function recentMatchMode(status: string): RecentMatchMode {
  return status === 'auto' ? 'auto' : 'manual';
}

/** Keep the most recent decision per receipt (a pair can have more than one match row). */
export function latestPerReceipt<T extends { receiptId: string; decidedAt: Date | null }>(rows: T[]): T[] {
  const byReceipt = new Map<string, T>();
  for (const row of rows) {
    const current = byReceipt.get(row.receiptId);
    if (!current || (row.decidedAt?.getTime() ?? 0) > (current.decidedAt?.getTime() ?? 0)) byReceipt.set(row.receiptId, row);
  }
  return [...byReceipt.values()].sort((a, b) => (b.decidedAt?.getTime() ?? 0) - (a.decidedAt?.getTime() ?? 0));
}

// ---------------------------------------------------------------------------------------------
// Shared presentation rows
// ---------------------------------------------------------------------------------------------

export type ReceiptRow = Receipt & { businessKey: string | null; businessName: string | null };
export type TransactionRow = Transaction & {
  businessKey: string;
  categoryName: string | null;
  categoryTaxCode: string | null;
  accountMask: string | null;
};

async function businessIdForKey(biz?: string): Promise<string | null | undefined> {
  if (!biz || biz === 'all') return undefined;
  const business = await db.query.businesses.findFirst({ where: eq(businesses.key, biz) });
  return business?.id ?? null;
}

export async function receiptRow(id: string): Promise<ReceiptRow | null> {
  const [row] = await db
    .select({ ...getTableColumns(receipts), businessKey: businesses.key, businessName: businesses.name })
    .from(receipts)
    .leftJoin(businesses, eq(receipts.businessId, businesses.id))
    .where(eq(receipts.id, id))
    .limit(1);
  return row ?? null;
}

export async function transactionRow(id: string): Promise<TransactionRow | null> {
  const [row] = await db
    .select({
      ...getTableColumns(transactions),
      businessKey: businesses.key,
      categoryName: categories.name,
      categoryTaxCode: categories.taxCode,
      accountMask: accounts.mask,
    })
    .from(transactions)
    .innerJoin(businesses, eq(transactions.businessId, businesses.id))
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(eq(transactions.id, id))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------------------------
// Match queue
// ---------------------------------------------------------------------------------------------

export interface QueueCandidate extends ReceiptMatchCandidate {
  explanations: MatchReason[];
}

export interface QueueItem {
  receipt: ReceiptRow;
  candidates: QueueCandidate[];
  blockedReason: QueueBlockedReason;
}

export function withExplanations(receipt: Receipt, candidates: ReceiptMatchCandidate[]): QueueCandidate[] {
  return candidates.map((candidate) => ({
    ...candidate,
    explanations: explainReceiptMatch(receipt, candidate.transaction, candidate.accountMask ?? null, candidate.reasons),
  }));
}

export async function queueItemForReceipt(receipt: ReceiptRow): Promise<QueueItem> {
  const blockedReason = queueBlockedReason(receipt);
  const candidates = blockedReason ? [] : shapeQueueCandidates(await receiptMatchCandidates(receipt.id));
  return { receipt, candidates: withExplanations(receipt, candidates), blockedReason };
}

export interface MatchQueuePage {
  items: QueueItem[];
  /** Unmatched receipts left in the queue (excluding `skip`). */
  total: number;
  /** Offset for the next page, or null at the end. */
  nextOffset: number | null;
}

/**
 * Unmatched receipts (pending, no transaction), each with its top candidates + reasons. `skip`
 * holds receipt ids the user skipped this session so they don't come straight back.
 */
export async function getMatchQueue(options: {
  limit?: number;
  offset?: number;
  skip?: string[];
  biz?: string;
  order?: 'newest' | 'oldest';
}): Promise<MatchQueuePage> {
  const limit = options.limit ?? 10;
  const offset = options.offset ?? 0;
  const businessId = await businessIdForKey(options.biz);
  if (businessId === null) return { items: [], total: 0, nextOffset: null };
  const where = and(
    eq(receipts.status, 'pending'),
    isNull(receipts.transactionId),
    businessId ? eq(receipts.businessId, businessId) : sql`true`,
    options.skip?.length ? notInArray(receipts.id, options.skip) : sql`true`,
  );
  const [countRow] = await db.select({ count: sql<number>`count(*)::int` }).from(receipts).where(where);
  const rows = await db
    .select({ ...getTableColumns(receipts), businessKey: businesses.key, businessName: businesses.name })
    .from(receipts)
    .leftJoin(businesses, eq(receipts.businessId, businesses.id))
    .where(where)
    .orderBy(
      // Receipts that can be paired from the keyboard first; ones needing manual details after.
      sql`CASE WHEN ${receipts.totalCents} IS NOT NULL AND ${receipts.receiptDate} IS NOT NULL THEN 0 ELSE 1 END`,
      options.order === 'oldest' ? sql`${receipts.createdAt} ASC` : desc(receipts.createdAt),
      receipts.id,
    )
    .limit(limit)
    .offset(offset);
  const items: QueueItem[] = [];
  for (const row of rows) items.push(await queueItemForReceipt(row));
  const total = Number(countRow?.count ?? 0);
  return { items, total, nextOffset: offset + rows.length < total ? offset + rows.length : null };
}

// ---------------------------------------------------------------------------------------------
// Recently matched
// ---------------------------------------------------------------------------------------------

export interface RecentMatch {
  matchId: string;
  mode: RecentMatchMode;
  matchedAt: string | null;
  score: number;
  receipt: ReceiptRow;
  transaction: TransactionRow;
  explanations: MatchReason[];
}

/** Live pairs (auto or manual) decided in the last `days` days, newest first. */
export async function recentMatches(options: {
  days?: number;
  limit?: number;
  offset?: number;
  mode?: RecentMatchMode | 'all';
  biz?: string;
}): Promise<{ items: RecentMatch[]; total: number }> {
  const days = options.days ?? 7;
  const businessId = await businessIdForKey(options.biz);
  if (businessId === null) return { items: [], total: 0 };
  const since = new Date(Date.now() - days * 86_400_000);
  const statuses = options.mode === 'auto' ? ['auto' as const] : options.mode === 'manual' ? ['accepted' as const] : ['auto' as const, 'accepted' as const];
  const rows = await db
    .select({
      matchId: receiptMatches.id,
      receiptId: receiptMatches.receiptId,
      status: receiptMatches.status,
      score: receiptMatches.score,
      decidedAt: receiptMatches.decidedAt,
    })
    .from(receiptMatches)
    // Only pairs that are still in place — an undone pair is 'rejected' and drops out anyway.
    .innerJoin(receipts, and(eq(receipts.id, receiptMatches.receiptId), eq(receipts.transactionId, receiptMatches.transactionId)))
    .innerJoin(transactions, and(eq(transactions.id, receiptMatches.transactionId), eq(transactions.receiptId, receiptMatches.receiptId)))
    .where(and(
      inArray(receiptMatches.status, statuses),
      gte(receiptMatches.decidedAt, since),
      businessId ? eq(transactions.businessId, businessId) : sql`true`,
    ))
    .orderBy(desc(receiptMatches.decidedAt))
    .limit(2000);
  const latest = latestPerReceipt(rows);
  const offset = options.offset ?? 0;
  const page = latest.slice(offset, offset + (options.limit ?? 50));
  const items: RecentMatch[] = [];
  for (const row of page) {
    const receipt = await receiptRow(row.receiptId);
    if (!receipt?.transactionId) continue;
    const transaction = await transactionRow(receipt.transactionId);
    if (!transaction) continue;
    items.push({
      matchId: row.matchId,
      mode: recentMatchMode(row.status),
      matchedAt: row.decidedAt?.toISOString() ?? null,
      score: Number(row.score),
      receipt,
      transaction,
      explanations: explainReceiptMatch(receipt, transaction, transaction.accountMask),
    });
  }
  return { items, total: latest.length };
}

// ---------------------------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------------------------

export interface ReceiptWorkflowCounts {
  unmatchedReceipts: number;
  missingReceipts: { count: number; cents: number };
  waivedThisMonth: { count: number; cents: number };
  autoMatchedThisWeek: number;
}

export async function receiptWorkflowCounts(options: { biz?: string; now?: Date } = {}): Promise<ReceiptWorkflowCounts> {
  const businessId = await businessIdForKey(options.biz);
  if (businessId === null) {
    return { unmatchedReceipts: 0, missingReceipts: { count: 0, cents: 0 }, waivedThisMonth: { count: 0, cents: 0 }, autoMatchedThisWeek: 0 };
  }
  const now = options.now ?? new Date();
  const monthStart = `${now.toISOString().slice(0, 7)}-01`;
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const txnBusiness = businessId ? eq(transactions.businessId, businessId) : sql`true`;

  const [unmatched, missing, waived, autoMatched] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` })
      .from(receipts)
      .where(and(eq(receipts.status, 'pending'), isNull(receipts.transactionId), businessId ? eq(receipts.businessId, businessId) : sql`true`)),
    // Same definition as the close queue / Inbox: operating outflow on enabled accounts.
    db.select({
      count: sql<number>`count(${transactions.id})::int`,
      cents: sql<number>`coalesce(abs(sum(${transactions.amountCents})), 0)::bigint`,
    }).from(transactions)
      .leftJoin(categories, eq(transactions.categoryId, categories.id))
      .leftJoin(accounts, eq(transactions.accountId, accounts.id))
      .where(and(txnBusiness, sql`${transactions.amountCents} < 0`, categoryIsVisibleSpend(), accountSpendFilter([]), eq(transactions.receiptStatus, 'missing'))),
    db.select({
      count: sql<number>`count(${transactions.id})::int`,
      cents: sql<number>`coalesce(abs(sum(${transactions.amountCents})), 0)::bigint`,
    }).from(transactions)
      .where(and(txnBusiness, eq(transactions.receiptStatus, 'waived'), gte(transactions.date, monthStart), sql`${transactions.amountCents} < 0`)),
    db.select({ count: sql<number>`count(DISTINCT ${receiptMatches.receiptId})::int` })
      .from(receiptMatches)
      .innerJoin(transactions, and(eq(transactions.id, receiptMatches.transactionId), eq(transactions.receiptId, receiptMatches.receiptId)))
      .where(and(eq(receiptMatches.status, 'auto'), gte(receiptMatches.decidedAt, weekAgo), txnBusiness)),
  ]);
  return {
    unmatchedReceipts: Number(unmatched[0]?.count ?? 0),
    missingReceipts: { count: Number(missing[0]?.count ?? 0), cents: Number(missing[0]?.cents ?? 0) },
    waivedThisMonth: { count: Number(waived[0]?.count ?? 0), cents: Number(waived[0]?.cents ?? 0) },
    autoMatchedThisWeek: Number(autoMatched[0]?.count ?? 0),
  };
}

// ---------------------------------------------------------------------------------------------
// Find in Gmail
// ---------------------------------------------------------------------------------------------

const MAX_MESSAGES_PER_MAILBOX = 10;
const MAX_INLINE_EXTRACTIONS = 5;

export type GmailHitStatus = 'paired_here' | 'paired_elsewhere' | 'candidate' | 'processing' | 'needs_details' | 'dismissed';

export interface GmailHit {
  receipt: ReceiptRow;
  status: GmailHitStatus;
  /** True when this search ingested the receipt (false: it was already in Ledger). */
  isNew: boolean;
  /** Score/reasons against the searched transaction, when the receipt has details. */
  score: number | null;
  explanations: MatchReason[];
}

export interface GmailMailboxResult {
  connectionId: string;
  email: string | null;
  messagesFound: number;
  newReceipts: number;
  error: string | null;
}

export interface FindInGmailResult {
  search: TransactionGmailQuery;
  searchable: boolean;
  mailboxes: GmailMailboxResult[];
  hits: GmailHit[];
  /** The transaction now has a receipt (found by this search or already). */
  paired: boolean;
  transaction: TransactionRow;
}

export function gmailHitStatus(receipt: Pick<Receipt, 'status' | 'transactionId' | 'totalCents' | 'receiptDate' | 'extractionError' | 'confidence'>, transactionId: string): GmailHitStatus {
  if (receipt.transactionId === transactionId) return 'paired_here';
  if (receipt.transactionId || receipt.status === 'matched') return 'paired_elsewhere';
  if (receipt.status === 'n/a') return 'dismissed';
  const blocked = queueBlockedReason(receipt);
  if (blocked === 'extraction_pending') return 'processing';
  if (blocked === 'missing_details') return 'needs_details';
  return 'candidate';
}

/**
 * Search every connected Gmail mailbox for one transaction's receipt, ingest hits through the
 * normal intake pipeline, extract a few inline so the answer is immediate, run the matcher, and
 * report what turned up.
 */
export async function findTransactionReceiptInGmail(transactionId: string): Promise<FindInGmailResult | null> {
  const transaction = await transactionRow(transactionId);
  if (!transaction) return null;
  const search = buildTransactionGmailQuery({
    merchant: transaction.merchant,
    amountCents: transaction.amountCents,
    date: transaction.date,
    authorizedDate: transaction.authorizedDate,
  });
  const searchable = search.amountVariants.length > 0 || search.merchantTerms.length > 0;
  const mailboxRows = await db
    .select({ id: connections.id, email: connections.gmailEmail })
    .from(connections)
    .where(and(
      eq(connections.kind, 'gmail'),
      eq(connections.status, 'live'),
      sql`${connections.encryptedRefreshToken} IS NOT NULL`,
    ));

  const mailboxes: GmailMailboxResult[] = [];
  const newIds = new Set<string>();
  const existingIds = new Set<string>();
  if (searchable) {
    for (const mailbox of mailboxRows) {
      try {
        const result = await searchGmailAndIngest(mailbox.id, search.query, {
          maxMessages: MAX_MESSAGES_PER_MAILBOX,
          extraction: 'defer',
        });
        result.newReceiptIds.forEach((id) => newIds.add(id));
        result.existingReceiptIds.forEach((id) => existingIds.add(id));
        mailboxes.push({
          connectionId: mailbox.id,
          email: mailbox.email,
          messagesFound: result.messageIds.length,
          newReceipts: result.newReceiptIds.length,
          error: null,
        });
      } catch (error) {
        mailboxes.push({
          connectionId: mailbox.id,
          email: mailbox.email,
          messagesFound: 0,
          newReceipts: 0,
          error: isGmailAuthError(error) ? 'Gmail access expired — reconnect this mailbox' : 'Gmail search failed',
        });
        console.warn('[receipts] find-in-gmail search failed', { connectionId: mailbox.id, error });
      }
    }
  }

  // Extract a handful inline so the user sees results now; the rest (and failures) go to the queue.
  const newList = [...newIds];
  const inline = newList.slice(0, MAX_INLINE_EXTRACTIONS);
  const settled = await Promise.allSettled(inline.map((id) => extractAndMatchReceipt(id)));
  const deferred = [
    ...newList.slice(MAX_INLINE_EXTRACTIONS),
    ...inline.filter((_, index) => settled[index]?.status === 'rejected'),
  ];
  for (const id of deferred) await enqueue('receipt.extract', { receiptId: id });
  // Receipts already in Ledger: give the matcher another look (cheap; skips anything final).
  for (const id of existingIds) {
    const existing = await db.query.receipts.findFirst({ where: eq(receipts.id, id) });
    if (existing && !receiptMatchSkipReason(existing)) await matchReceipt(id);
  }

  const hits: GmailHit[] = [];
  for (const id of [...newIds, ...existingIds]) {
    const receipt = await receiptRow(id);
    if (!receipt) continue;
    const status = gmailHitStatus(receipt, transactionId);
    const scorable = receipt.totalCents != null && receipt.receiptDate != null;
    hits.push({
      receipt,
      status,
      isNew: newIds.has(id),
      score: scorable ? scoreMatch(receipt, transaction, transaction.accountMask).score : null,
      explanations: scorable ? explainReceiptMatch(receipt, transaction, transaction.accountMask) : [],
    });
  }
  const statusOrder: GmailHitStatus[] = ['paired_here', 'candidate', 'processing', 'needs_details', 'paired_elsewhere', 'dismissed'];
  hits.sort((a, b) => statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status) || (b.score ?? 0) - (a.score ?? 0));

  const refreshed = (await transactionRow(transactionId)) ?? transaction;
  return {
    search,
    searchable,
    mailboxes,
    hits,
    paired: Boolean(refreshed.receiptId),
    transaction: refreshed,
  };
}
