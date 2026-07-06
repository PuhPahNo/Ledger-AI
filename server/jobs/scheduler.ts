import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { connections, jobs, receipts } from '../db/schema.js';
import { enqueue } from './queue.js';

export const DAILY_PLAID_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DAILY_CATEGORIZATION_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const GMAIL_WATCH_RENEWAL_WINDOW_MS = 6 * 24 * 60 * 60 * 1000;
export const RECEIPT_REMATCH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PENDING_RECEIPT_EXTRACTION_LIMIT = 50;

export function isPlaidConnectionDueForDailySync(
  lastSyncAt: Date | null | undefined,
  now = new Date(),
): boolean {
  return !lastSyncAt || now.getTime() - lastSyncAt.getTime() >= DAILY_PLAID_SYNC_INTERVAL_MS;
}

export function isGmailWatchRenewalDue(
  gmailWatchExpiration: Date | null | undefined,
  now = new Date(),
): boolean {
  return !gmailWatchExpiration || gmailWatchExpiration.getTime() - now.getTime() <= GMAIL_WATCH_RENEWAL_WINDOW_MS;
}

export async function enqueueDuePlaidSyncs(now = new Date()): Promise<number> {
  const rows = await db
    .select({
      id: connections.id,
      lastSyncAt: connections.lastSyncAt,
    })
    .from(connections)
    .where(and(
      sql`${connections.kind} <> 'gmail'`,
      eq(connections.status, 'live'),
      sql`${connections.encryptedAccessToken} IS NOT NULL`,
    ));

  let queued = 0;
  for (const row of rows) {
    if (!isPlaidConnectionDueForDailySync(row.lastSyncAt, now)) continue;
    if (await hasPendingPlaidSync(row.id)) continue;
    await enqueue('plaid.sync', { connectionId: row.id }, now);
    queued += 1;
  }
  return queued;
}

export async function enqueueDueGmailWatchRenewals(now = new Date()): Promise<number> {
  if (!process.env.GOOGLE_PUBSUB_TOPIC) return 0;

  const rows = await db
    .select({
      id: connections.id,
      gmailWatchExpiration: connections.gmailWatchExpiration,
    })
    .from(connections)
    .where(and(
      eq(connections.kind, 'gmail'),
      eq(connections.status, 'live'),
      sql`${connections.encryptedRefreshToken} IS NOT NULL`,
    ));

  let queued = 0;
  for (const row of rows) {
    if (!isGmailWatchRenewalDue(row.gmailWatchExpiration, now)) continue;
    if (await hasPendingGmailWatchRenewal(row.id)) continue;
    await enqueue('gmail.renew-watch', { connectionId: row.id }, now);
    queued += 1;
  }
  return queued;
}

export async function enqueueDueCategorizationScan(now = new Date()): Promise<number> {
  if (await hasRecentCategorizationScan(now)) return 0;
  // Rules and signals are cheap and AI calls self-limit via the daily budget, so the
  // scan can chew through a real backlog instead of 100 rows per day.
  await enqueue('categorization.scan-uncategorized', { limit: 500 }, now);
  return 1;
}

export async function enqueuePendingReceiptExtractions(now = new Date()): Promise<number> {
  const rows = await db
    .select({ id: receipts.id })
    .from(receipts)
    .where(and(
      eq(receipts.status, 'pending'),
      sql`${receipts.fileKey} IS NOT NULL`,
      sql`${receipts.mimeType} IS NOT NULL`,
      sql`${receipts.fileName} IS NOT NULL`,
      isNull(receipts.merchant),
      isNull(receipts.totalCents),
      isNull(receipts.receiptDate),
    ))
    .limit(PENDING_RECEIPT_EXTRACTION_LIMIT);

  let queued = 0;
  for (const row of rows) {
    if (await hasReceiptExtractionJob(row.id)) continue;
    await enqueue('receipt.extract', { receiptId: row.id }, now);
    queued += 1;
  }
  return queued;
}

export async function enqueueDueReceiptRematch(now = new Date()): Promise<number> {
  if (await hasRecentReceiptRematch(now)) return 0;
  const [pending] = await db
    .select({ id: receipts.id })
    .from(receipts)
    .where(and(
      isNull(receipts.transactionId),
      eq(receipts.status, 'pending'),
      sql`${receipts.totalCents} IS NOT NULL`,
      sql`${receipts.receiptDate} IS NOT NULL`,
    ))
    .limit(1);
  if (!pending) return 0;
  await enqueue('receipt.rematch', {}, now);
  return 1;
}

async function hasRecentReceiptRematch(now: Date): Promise<boolean> {
  const cutoff = new Date(now.getTime() - RECEIPT_REMATCH_INTERVAL_MS);
  const [existing] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(
      eq(jobs.type, 'receipt.rematch'),
      sql`${jobs.createdAt} >= ${cutoff}`,
      or(
        inArray(jobs.status, ['queued', 'running', 'failed']),
        eq(jobs.status, 'succeeded'),
      ),
    ))
    .limit(1);

  return Boolean(existing);
}

async function hasPendingPlaidSync(connectionId: string): Promise<boolean> {
  const [existing] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(
      eq(jobs.type, 'plaid.sync'),
      inArray(jobs.status, ['queued', 'running', 'failed']),
      sql`${jobs.attempts} < ${jobs.maxAttempts}`,
      sql`${jobs.payload} ->> 'connectionId' = ${connectionId}`,
    ))
    .limit(1);

  return Boolean(existing);
}

async function hasPendingGmailWatchRenewal(connectionId: string): Promise<boolean> {
  const [existing] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(
      eq(jobs.type, 'gmail.renew-watch'),
      inArray(jobs.status, ['queued', 'running', 'failed']),
      sql`${jobs.attempts} < ${jobs.maxAttempts}`,
      sql`${jobs.payload} ->> 'connectionId' = ${connectionId}`,
    ))
    .limit(1);

  return Boolean(existing);
}

async function hasRecentCategorizationScan(now: Date): Promise<boolean> {
  const cutoff = new Date(now.getTime() - DAILY_CATEGORIZATION_SCAN_INTERVAL_MS);
  const [existing] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(
      eq(jobs.type, 'categorization.scan-uncategorized'),
      sql`${jobs.createdAt} >= ${cutoff}`,
      or(
        inArray(jobs.status, ['queued', 'running', 'failed']),
        eq(jobs.status, 'succeeded'),
      ),
    ))
    .limit(1);

  return Boolean(existing);
}

async function hasReceiptExtractionJob(receiptId: string): Promise<boolean> {
  const [existing] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(
      eq(jobs.type, 'receipt.extract'),
      inArray(jobs.status, ['queued', 'running', 'failed', 'succeeded']),
      sql`${jobs.payload} ->> 'receiptId' = ${receiptId}`,
    ))
    .limit(1);

  return Boolean(existing);
}
