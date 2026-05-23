import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type archiverType from 'archiver';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { businesses, categories, categoryRules, exportJobs, receipts, transactions } from '../db/schema.js';
import { toCsv } from '../lib/csv.js';
import { storage } from './storage.js';

const require = createRequire(import.meta.url);
const archiver = require('archiver') as typeof archiverType;

export async function buildExport(exportJobId: string): Promise<void> {
  const job = await db.query.exportJobs.findFirst({ where: eq(exportJobs.id, exportJobId) });
  if (!job) throw new Error(`Export job ${exportJobId} not found`);

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

  const receiptRows = await db
    .select()
    .from(receipts)
    .where(and(
      gte(receipts.createdAt, new Date(`${job.dateFrom}T00:00:00Z`)),
      lte(receipts.createdAt, new Date(`${job.dateTo}T23:59:59Z`)),
      job.businessId ? eq(receipts.businessId, job.businessId) : sql`true`,
    ));

  const categoryRows = await db.select().from(categories);
  const ruleRows = await db.select().from(categoryRules);

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
