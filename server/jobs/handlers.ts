import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { exportJobs } from '../db/schema.js';
import { rematchUnmatchedReceipts } from '../services/matching.js';
import { extractAndMatchReceipt } from '../services/receiptProcessing.js';
import { backfillWaiverEvidence } from '../services/receiptWaivers.js';
import { enqueue } from './queue.js';
import {
  resolveCategorizationReviewItem,
  reviewReceiptCategoryEvidence,
  scanUncategorizedTransactions,
} from '../services/categorizationFeedback.js';
import { sweepOpenLearnPrompts } from '../services/categorizationLearning.js';
import { syncPlaidConnection } from '../services/plaid.js';
import { backfillGmail, gmailBackfillQuery, renewGmailWatch, syncGmailConnection } from '../services/gmail.js';
import { regenerateInsights } from '../services/insights.js';
import { buildExport } from '../services/exporter.js';
import { relinkQuickbooksConnection, syncQuickbooksConnection } from '../services/quickbooksSync.js';

export async function handleJob(type: string, payload: Record<string, unknown>): Promise<void> {
  if (type === 'plaid.sync') {
    const result = await syncPlaidConnection(String(payload.connectionId), {
      resetCursor: Boolean(payload.resetCursor),
      daysRequested: typeof payload.daysRequested === 'number' ? payload.daysRequested : undefined,
      allowAiCategorization: payload.resetCursor ? false : undefined,
    });
    // New transactions may match receipts that arrived before the charge posted, and
    // modified/removed ones (pending→posted swaps, amount corrections) can free receipts up.
    if (result.added > 0 || result.changed > 0) {
      await enqueue('receipt.rematch', {});
      // The upsert path can waive receipts by rule but can't record which rule (no row id yet).
      await enqueue('receipt.waiver-evidence', {});
    }
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
  if (type === 'receipt.waiver-evidence') {
    await backfillWaiverEvidence();
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
    // Nightly: answer legacy learn prompts (expire satisfied ones, auto-learn consistent
    // merchants). Rides on the daily scan so it needs no scheduler entry of its own.
    await sweepOpenLearnPrompts();
    return;
  }
  if (type === 'categorization.learn-sweep') {
    await sweepOpenLearnPrompts(typeof payload.limit === 'number' ? payload.limit : undefined);
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
  if (type === 'quickbooks.sync') {
    const result = await syncQuickbooksConnection(String(payload.connectionId), { full: Boolean(payload.full) });
    // New QBO links can pair receipts; newly imported QBO receipts may match other transactions.
    if (result && (result.linksCreated > 0 || result.receiptsImported > 0)) await enqueue('receipt.rematch', {});
    return;
  }
  if (type === 'quickbooks.relink') {
    await relinkQuickbooksConnection(String(payload.connectionId));
    return;
  }
  throw new Error(`Unknown job type: ${type}`);
}
