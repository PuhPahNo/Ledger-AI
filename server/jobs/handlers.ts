import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { exportJobs, receipts } from '../db/schema.js';
import { extractReceipt } from '../services/receiptExtraction.js';
import { storage } from '../services/storage.js';
import { matchReceipt } from '../services/matching.js';
import { syncPlaidConnection } from '../services/plaid.js';
import { renewGmailWatch, syncGmailConnection } from '../services/gmail.js';
import { regenerateInsights } from '../services/insights.js';
import { buildExport } from '../services/exporter.js';

export async function handleJob(type: string, payload: Record<string, unknown>): Promise<void> {
  if (type === 'plaid.sync') {
    await syncPlaidConnection(String(payload.connectionId));
    return;
  }
  if (type === 'gmail.sync') {
    await syncGmailConnection(String(payload.connectionId), payload.historyId ? String(payload.historyId) : undefined);
    return;
  }
  if (type === 'gmail.renew-watch') {
    await renewGmailWatch(String(payload.connectionId));
    return;
  }
  if (type === 'receipt.extract') {
    await extractAndMatchReceipt(String(payload.receiptId));
    return;
  }
  if (type === 'insights.generate') {
    await regenerateInsights();
    return;
  }
  if (type === 'export.build') {
    const exportId = String(payload.exportJobId);
    await db.update(exportJobs).set({ status: 'running', updatedAt: new Date() }).where(eq(exportJobs.id, exportId));
    await buildExport(exportId);
    return;
  }
  throw new Error(`Unknown job type: ${type}`);
}

async function extractAndMatchReceipt(receiptId: string): Promise<void> {
  const receipt = await db.query.receipts.findFirst({ where: eq(receipts.id, receiptId) });
  if (!receipt?.fileKey || !receipt.mimeType || !receipt.fileName) return;
  const chunks: Buffer[] = [];
  const stream = await storage().getStream(receipt.fileKey);
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const extraction = await extractReceipt({
    buffer: Buffer.concat(chunks),
    mimeType: receipt.mimeType,
    fileName: receipt.fileName,
  });
  await db.update(receipts).set({
    merchant: extraction.merchant,
    totalCents: extraction.totalCents,
    receiptDate: extraction.receiptDate,
    confidence: String(extraction.confidence),
    ocrJson: extraction,
    updatedAt: new Date(),
  }).where(eq(receipts.id, receiptId));
  await matchReceipt(receiptId);
}
