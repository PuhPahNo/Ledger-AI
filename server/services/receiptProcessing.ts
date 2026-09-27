import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { receipts } from '../db/schema.js';
import { reviewReceiptCategoryEvidence } from './categorizationFeedback.js';
import { matchReceipt } from './matching.js';
import {
  extractReceipt,
  isPermanentExtractionFailure,
  PermanentExtractionError,
  receiptExtractionUpdate,
  unsupportedReceiptFileReason,
  type ReceiptExtraction,
} from './receiptExtraction.js';
import { storage } from './storage.js';
import { applyTagRulesBestEffort } from './tagging.js';

/**
 * Extract a stored receipt file and run the matcher on it. Source-agnostic: uploads, Gmail, and
 * any future source (e.g. QuickBooks attachments) go through here. Used by the `receipt.extract`
 * job and inline by "Find in Gmail". Throws on retryable failures (the job queue retries);
 * permanent failures are recorded on the receipt and swallowed.
 */
export async function extractAndMatchReceipt(receiptId: string): Promise<void> {
  const receipt = await db.query.receipts.findFirst({ where: eq(receipts.id, receiptId) });
  if (!receipt?.fileKey || !receipt.mimeType || !receipt.fileName) return;

  let extraction: ReceiptExtraction;
  try {
    const unsupported = unsupportedReceiptFileReason({ mimeType: receipt.mimeType, fileName: receipt.fileName });
    if (unsupported) throw new PermanentExtractionError(unsupported);
    const chunks: Buffer[] = [];
    const stream = await storage().getStream(receipt.fileKey);
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    extraction = await extractReceipt({
      buffer: Buffer.concat(chunks),
      mimeType: receipt.mimeType,
      fileName: receipt.fileName,
    });
  } catch (error) {
    // A receipt with no total/date can never match, and the failed job isn't anywhere the
    // user looks — leave the reason on the receipt so the workbench can ask for manual entry.
    await db.update(receipts).set({
      extractionError: error instanceof Error ? error.message : String(error),
      updatedAt: new Date(),
    }).where(eq(receipts.id, receiptId));
    // Permanent failures (e.g. HEIC) would fail identically — and be billed — on every retry.
    if (isPermanentExtractionFailure(error)) return;
    throw error;
  }

  // Re-read: the user may have edited, paired, or dismissed the receipt while extraction ran.
  const current = await db.query.receipts.findFirst({ where: eq(receipts.id, receiptId) });
  if (!current) return;
  await db.update(receipts)
    .set({ ...receiptExtractionUpdate(current, extraction), updatedAt: new Date() })
    .where(eq(receipts.id, receiptId));

  if (current.transactionId) {
    // Paired before its contents were known (uploaded straight onto a transaction, or paired by
    // hand while extraction ran): the pair-time category review saw an empty receipt, so rerun it.
    try {
      await reviewReceiptCategoryEvidence({ transactionId: current.transactionId, receiptId, matchScore: null });
      await applyTagRulesBestEffort(current.transactionId);
    } catch (error) {
      console.warn('[receipts] post-extraction enrichment failed', { receiptId, error });
    }
    return;
  }
  await matchReceipt(receiptId);
}
