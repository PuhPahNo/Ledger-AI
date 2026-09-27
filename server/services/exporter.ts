import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type archiverType from 'archiver';
import { and, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { businesses, categories, categoryRules, exportJobs, receipts, transactions } from '../db/schema.js';
import { toCsv } from '../lib/csv.js';
import { storage } from './storage.js';
import { NonRetryableJobError } from '../jobs/queue.js';

const require = createRequire(import.meta.url);
const archiver = require('archiver') as typeof archiverType;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Strict YYYY-MM-DD that is also a real calendar date (rejects 2026-02-30). */
export function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
}

/** Returns an error message for an invalid export range, or null when it is usable. */
export function exportDateRangeError(dateFrom: string, dateTo: string): string | null {
  if (!isIsoDate(dateFrom)) return 'dateFrom must be a valid YYYY-MM-DD date';
  if (!isIsoDate(dateTo)) return 'dateTo must be a valid YYYY-MM-DD date';
  if (dateFrom > dateTo) return 'dateFrom must be on or before dateTo';
  return null;
}

export async function buildExport(exportJobId: string): Promise<void> {
  const job = await db.query.exportJobs.findFirst({ where: eq(exportJobs.id, exportJobId) });
  if (!job) throw new NonRetryableJobError(`Export job ${exportJobId} not found`);
  // Already built by an earlier attempt (e.g. the worker died after uploading): don't redo it.
  if (job.status === 'ready' && job.fileKey) return;
  const rangeError = exportDateRangeError(job.dateFrom, job.dateTo);
  if (rangeError) {
    await db.update(exportJobs).set({ status: 'failed', error: rangeError, updatedAt: new Date() }).where(eq(exportJobs.id, exportJobId));
    // Same input fails the same way every time — don't rebuild the zip 4 more times.
    throw new NonRetryableJobError(rangeError);
  }

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ledger-export-'));
  const zipPath = path.join(tempDir, `${exportJobId}.zip`);

  try {
    await writeZip(zipPath, job);
    const key = `exports/${exportJobId}.zip`;
    await storage().put({ key, body: fs.createReadStream(zipPath), contentType: 'application/zip' });
    await db.update(exportJobs).set({ status: 'ready', fileKey: key, updatedAt: new Date() }).where(eq(exportJobs.id, exportJobId));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(exportJobs).set({ status: 'failed', error: message, updatedAt: new Date() }).where(eq(exportJobs.id, exportJobId));
    throw error;
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

async function writeZip(zipPath: string, job: typeof exportJobs.$inferSelect): Promise<void> {
  const output = fs.createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(output);

  const txnRows = await db
    .select({
      id: transactions.id,
      date: transactions.date,
      merchant: transactions.merchant,
      amountCents: transactions.amountCents,
      receiptStatus: transactions.receiptStatus,
      source: transactions.sourceLabel,
      business: businesses.name,
      category: categories.name,
      receiptId: transactions.receiptId,
    })
    .from(transactions)
    .innerJoin(businesses, eq(transactions.businessId, businesses.id))
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(and(
      gte(transactions.date, job.dateFrom),
      lte(transactions.date, job.dateTo),
      job.businessId ? eq(transactions.businessId, job.businessId) : sql`true`,
    ));

  // A receipt belongs to the period of its purchase date; only fall back to the upload day
  // (UTC, as before) when extraction never produced one.
  const receiptDay = sql`coalesce(${receipts.receiptDate}, (${receipts.createdAt} AT TIME ZONE 'UTC')::date)`;
  const receiptRows = await db
    .select()
    .from(receipts)
    .where(and(
      sql`${receiptDay} >= ${job.dateFrom}::date`,
      sql`${receiptDay} <= ${job.dateTo}::date`,
      job.businessId ? eq(receipts.businessId, job.businessId) : sql`true`,
    ));

  // A single-business export must not leak other businesses' categories and rules.
  const categoryRows = await db
    .select()
    .from(categories)
    .where(job.businessId ? or(isNull(categories.businessId), eq(categories.businessId, job.businessId)) : sql`true`);
  const ruleRows = await db
    .select()
    .from(categoryRules)
    .where(job.businessId ? or(isNull(categoryRules.businessId), eq(categoryRules.businessId, job.businessId)) : sql`true`);

  archive.append(toCsv(txnRows), { name: 'transactions.csv' });
  archive.append(toCsv(receiptRows.map((row) => ({
    id: row.id,
    source: row.source,
    status: row.status,
    merchant: row.merchant,
    totalCents: row.totalCents,
    receiptDate: row.receiptDate,
    fileName: row.fileName,
    transactionId: row.transactionId,
  }))), { name: 'receipts.csv' });
  archive.append(toCsv(categoryRows), { name: 'categories.csv' });
  archive.append(toCsv(ruleRows), { name: 'category-rules.csv' });
  archive.append(JSON.stringify({
    exportId: job.id,
    dateFrom: job.dateFrom,
    dateTo: job.dateTo,
    businessId: job.businessId ?? null,
    generatedAt: new Date().toISOString(),
  }, null, 2), { name: 'manifest.json' });

  for (const receipt of receiptRows) {
    if (!receipt.fileKey) continue;
    try {
      const stream = await storage().getStream(receipt.fileKey);
      archive.append(stream, { name: `receipt-files/${receipt.id}-${receipt.fileName ?? 'receipt'}` });
    } catch {
      archive.append(`Missing receipt file: ${receipt.fileKey}\n`, { name: `receipt-files/${receipt.id}-MISSING.txt` });
    }
  }

  await archive.finalize();
  await new Promise<void>((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
  });
}
