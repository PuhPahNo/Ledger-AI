import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { exportJobs, receipts } from '../db/schema.js';
import { extractReceipt } from '../services/receiptExtraction.js';
import { storage } from '../services/storage.js';
import { matchReceipt, rematchUnmatchedReceipts } from '../services/matching.js';
import { enqueue } from './queue.js';
import {
  resolveCategorizationReviewItem,
  reviewReceiptCategoryEvidence,
  scanUncategorizedTransactions,
} from '../services/categorizationFeedback.js';
import { syncPlaidConnection } from '../services/plaid.js';
import { backfillGmail, gmailBackfillQuery, renewGmailWatch, syncGmailConnection } from '../services/gmail.js';
import { regenerateInsights } from '../services/insights.js';
import { buildExport } from '../services/exporter.js';

export async function handleJob(type: string, payload: Record<string, unknown>): Promise<void> {
  if (type === 'plaid.sync') {
    const result = await syncPlaidConnection(String(payload.connectionId), {
      resetCursor: Boolean(payload.resetCursor),
      daysRequested: typeof payload.daysRequested === 'number' ? payload.daysRequested : undefined,
      allowAiCategorization: payload.resetCursor ? false : undefined,
    });
    // New transactions may match receipts that arrived before the charge posted, and
    // modified/removed ones (pending→posted swaps, amount corrections) can free receipts up.
    if (result.added > 0 || result.changed > 0) await enqueue('receipt.rematch', {});
    return;
  }
  if (type === 'gmail.sync') {
    await syncGmailConnection(String(payload.connectionId), payload.historyId ? String(payload.historyId) : undefined);
    return;
  }
  if (type === 'gmail.backfill') {
    const daysRequested = typeof payload.daysRequested === 'number' ? payload.daysRequested : undefined;
    await backfillGmail(String(payload.connectionId), gmailBackfillQuery(daysRequested));
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
  if (type === 'receipt.rematch') {
    await rematchUnmatchedReceipts();
    return;
  }
  if (type === 'categorization.apply-rule') {
    await resolveCategorizationReviewItem({
      id: String(payload.reviewItemId),
      action: 'accept',
      userId: typeof payload.userId === 'string' ? payload.userId : undefined,
    });
    return;
  }
  if (type === 'categorization.scan-uncategorized') {
    await scanUncategorizedTransactions({
      businessId: typeof payload.businessId === 'string' ? payload.businessId : undefined,
      limit: typeof payload.limit === 'number' ? payload.limit : undefined,
    });
    return;
  }
  if (type === 'categorization.receipt-evidence-review') {
    await reviewReceiptCategoryEvidence({
      transactionId: String(payload.transactionId),
      receiptId: String(payload.receiptId),
      matchScore: typeof payload.matchScore === 'number' ? payload.matchScore : undefined,
    });
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
