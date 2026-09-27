import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { requireUser } from '../auth/session.js';
import { db } from '../db/client.js';
import { receiptMatches, receipts, transactions } from '../db/schema.js';
import { enqueue } from '../jobs/queue.js';
import { sha256Buffer } from '../lib/crypto.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { getReceiptTrackingSince } from '../services/appSettings.js';
import { audit } from '../services/audit.js';
import { sanitizeFileName } from '../services/gmailReceiptIntake.js';
import { attachReceipt } from '../services/matching.js';
import {
  findTransactionReceiptInGmail,
  getMatchQueue,
  receiptRow,
  receiptWorkflowCounts,
  recentMatches,
  transactionRow,
  type QueueItem,
  type RecentMatch,
  type TransactionRow,
} from '../services/receiptWorkflow.js';
import {
  applyWaiversToMissing,
  createCategoryRule,
  createMerchantRule,
  DEFAULT_WAIVER_THRESHOLD_CENTS,
  deleteWaiverRule,
  describeWaiverRule,
  listWaiverRules,
  previewApplyWaivers,
  unwaiveTransaction,
  updateWaiverRule,
  upsertThresholdRule,
  waiveTransaction,
  WaiveTransactionError,
  WaiverRuleInputError,
  waiverEvidenceFor,
} from '../services/receiptWaivers.js';
import { storage } from '../services/storage.js';
import { toApiMatchCandidate, toApiReceipt, toApiTransaction, toApiWaiverRule } from './mappers.js';

const uuid = z.string().uuid();
const skipList = z.union([z.string(), z.array(z.string())]).optional().transform((value) => {
  const raw = Array.isArray(value) ? value : (value ?? '').split(',');
  return raw.map((item) => item.trim()).filter((item) => uuid.safeParse(item).success).slice(0, 500);
});

function apiTransaction(row: TransactionRow) {
  return toApiTransaction(row);
}

function apiQueueItem(item: QueueItem) {
  return {
    receipt: toApiReceipt(item.receipt),
    blockedReason: item.blockedReason,
    candidates: item.candidates.map((candidate) => toApiMatchCandidate(candidate)),
  };
}

function apiRecentMatch(item: RecentMatch) {
  return {
    matchId: item.matchId,
    mode: item.mode,
    matchedAt: item.matchedAt,
    score: item.score,
    receipt: toApiReceipt(item.receipt),
    transaction: apiTransaction(item.transaction),
    explanations: item.explanations,
  };
}

async function nextQueueStep(skip: string[], biz?: string) {
  const page = await getMatchQueue({ limit: 1, skip, biz });
  return { next: page.items[0] ? apiQueueItem(page.items[0]) : null, remaining: page.total };
}

function rethrowWaiverError(error: unknown): never {
  if (error instanceof WaiverRuleInputError || error instanceof WaiveTransactionError) badRequest(error.message);
  throw error;
}

/**
 * Receipt workflow API: match queue, recently matched (+undo via /receipts/:id/unpair), counts,
 * "no receipt needed" rules, and per-transaction missing-receipt actions. See BACKEND.md.
 */
export async function receiptWorkflowRoutes(app: FastifyInstance): Promise<void> {
  // ---- Match queue --------------------------------------------------------------------------

  app.get('/receipts/queue', async (request) => {
    await requireUser(request);
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(50).default(10),
      offset: z.coerce.number().int().min(0).max(100_000).default(0),
      skip: skipList,
      biz: z.string().optional(),
      order: z.enum(['newest', 'oldest']).default('newest'),
    }).parse(request.query);
    const page = await getMatchQueue(query);
    return { items: page.items.map(apiQueueItem), total: page.total, nextOffset: page.nextOffset };
  });

  app.post('/receipts/queue/:id/pair', async (request) => {
    const user = await requireUser(request);
    const params = z.object({ id: uuid }).parse(request.params);
    const body = z.object({
      transactionId: uuid,
      skip: z.array(uuid).max(500).default([]),
      biz: z.string().optional(),
    }).parse(request.body);
    const updated = await attachReceipt(body.transactionId, params.id);
    if (!updated) notFound('Receipt or transaction not found');
    await audit(request, user, 'attach_receipt', 'transaction', body.transactionId, { receiptId: params.id, via: 'match_queue' });
    const [transaction, receipt] = await Promise.all([transactionRow(body.transactionId), receiptRow(params.id)]);
    return {
      transaction: transaction ? apiTransaction(transaction) : null,
      receipt: receipt ? toApiReceipt(receipt) : null,
      ...(await nextQueueStep([...body.skip, params.id], body.biz)),
    };
  });

  app.post('/receipts/queue/:id/dismiss', async (request) => {
    const user = await requireUser(request);
    const params = z.object({ id: uuid }).parse(request.params);
    const body = z.object({ skip: z.array(uuid).max(500).default([]), biz: z.string().optional() }).parse(request.body ?? {});
    const [receipt] = await db.update(receipts)
      .set({ status: 'n/a', updatedAt: new Date() })
      .where(eq(receipts.id, params.id))
      .returning();
    if (!receipt) notFound('Receipt not found');
    // Same as POST /receipts/:id/dismiss: every proposal for it is rejected.
    await db.update(receiptMatches)
      .set({ status: 'rejected', decidedAt: new Date() })
      .where(and(eq(receiptMatches.receiptId, params.id), ne(receiptMatches.status, 'rejected')));
    await audit(request, user, 'dismiss_receipt', 'receipt', params.id, { via: 'match_queue' });
    const row = await receiptRow(params.id);
    return { receipt: row ? toApiReceipt(row) : null, ...(await nextQueueStep([...body.skip, params.id], body.biz)) };
  });

  // ---- Recently matched ---------------------------------------------------------------------

  app.get('/receipts/recent-matches', async (request) => {
    await requireUser(request);
    const query = z.object({
      days: z.coerce.number().int().min(1).max(90).default(7),
      mode: z.enum(['auto', 'manual', 'all']).default('all'),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).max(10_000).default(0),
      biz: z.string().optional(),
    }).parse(request.query);
    const result = await recentMatches(query);
    return { items: result.items.map(apiRecentMatch), total: result.total };
  });

  // ---- Counts -------------------------------------------------------------------------------

  app.get('/receipts/counts', async (request) => {
    await requireUser(request);
    const query = z.object({ biz: z.string().optional() }).parse(request.query);
    return receiptWorkflowCounts(query);
  });

  // ---- Waiver rules ("no receipt needed") ---------------------------------------------------

  app.get('/receipts/waiver-rules', async (request) => {
    await requireUser(request);
    const rules = await listWaiverRules();
    return { rules: rules.map((rule) => toApiWaiverRule(rule, describeWaiverRule(rule, rule.categoryName))) };
  });

  app.put('/receipts/waiver-rules/threshold', async (request) => {
    const user = await requireUser(request);
    const body = z.object({
      enabled: z.boolean(),
      thresholdCents: z.number().int().min(100).max(1_000_000).default(DEFAULT_WAIVER_THRESHOLD_CENTS),
      excludeLodging: z.boolean().default(true),
    }).parse(request.body);
    const rule = await upsertThresholdRule({ ...body, userId: user.id });
    await audit(request, user, 'update_receipt_waiver_threshold', 'receipt_waiver_rule', rule.id, body);
    return toApiWaiverRule(rule, describeWaiverRule(rule));
  });

  app.post('/receipts/waiver-rules', async (request) => {
    const user = await requireUser(request);
    const body = z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('merchant'),
        merchant: z.string().trim().min(2).max(160),
        businessId: uuid.nullable().optional(),
        note: z.string().trim().max(300).nullable().optional(),
        applyToExisting: z.boolean().default(false),
      }),
      z.object({
        kind: z.literal('category'),
        categoryId: uuid,
        note: z.string().trim().max(300).nullable().optional(),
        applyToExisting: z.boolean().default(false),
      }),
    ]).parse(request.body);
    try {
      const { rule, created } = body.kind === 'merchant'
        ? await createMerchantRule({ merchant: body.merchant, businessId: body.businessId, note: body.note, userId: user.id })
        : await createCategoryRule({ categoryId: body.categoryId, note: body.note, userId: user.id });
      const applied = body.applyToExisting ? await applyWaiversToMissing({ ruleId: rule.id, userId: user.id }) : { waived: 0 };
      await audit(request, user, 'create_receipt_waiver_rule', 'receipt_waiver_rule', rule.id, { ...body, created, waived: applied.waived });
      const listed = (await listWaiverRules()).find((row) => row.id === rule.id);
      return {
        rule: toApiWaiverRule(listed ?? rule, describeWaiverRule(rule, listed?.categoryName)),
        created,
        waived: applied.waived,
      };
    } catch (error) {
      rethrowWaiverError(error);
    }
  });

  app.patch('/receipts/waiver-rules/:id', async (request) => {
    const user = await requireUser(request);
    const params = z.object({ id: uuid }).parse(request.params);
    const body = z.object({
      enabled: z.boolean().optional(),
      note: z.string().trim().max(300).nullable().optional(),
    }).parse(request.body);
    const rule = await updateWaiverRule(params.id, body);
    if (!rule) notFound('Rule not found');
    await audit(request, user, 'update_receipt_waiver_rule', 'receipt_waiver_rule', params.id, body);
    return toApiWaiverRule(rule, describeWaiverRule(rule));
  });

  // `reopen=true` puts the transactions this rule waived back to 'missing' (count: rule.waivedCount).
  app.delete('/receipts/waiver-rules/:id', async (request) => {
    const user = await requireUser(request);
    const params = z.object({ id: uuid }).parse(request.params);
    const query = z.object({ reopen: z.enum(['true', 'false']).default('false').transform((value) => value === 'true') }).parse(request.query);
    try {
      const result = await deleteWaiverRule(params.id, { reopen: query.reopen });
      if (!result) notFound('Rule not found');
      await audit(request, user, 'delete_receipt_waiver_rule', 'receipt_waiver_rule', params.id, result);
      return result;
    } catch (error) {
      rethrowWaiverError(error);
    }
  });

  app.get('/receipts/waiver-rules/apply-preview', async (request) => {
    await requireUser(request);
    const query = z.object({ ruleId: uuid.optional() }).parse(request.query);
    return previewApplyWaivers(query.ruleId);
  });

  app.post('/receipts/waiver-rules/apply', async (request) => {
    const user = await requireUser(request);
    const body = z.object({ ruleId: uuid.optional() }).parse(request.body ?? {});
    const result = await applyWaiversToMissing({ ruleId: body.ruleId, userId: user.id });
    await audit(request, user, 'apply_receipt_waiver_rules', 'transaction', 'bulk', { ...body, ...result });
    return result;
  });

  // ---- Missing-receipt actions on one transaction -------------------------------------------

  // Upload a file straight onto a transaction: stored, paired manually (no guessing), extracted.
  app.post('/transactions/:id/receipt/upload', async (request) => {
    const user = await requireUser(request);
    const params = z.object({ id: uuid }).parse(request.params);
    const transaction = await db.query.transactions.findFirst({ where: eq(transactions.id, params.id) });
    if (!transaction) notFound('Transaction not found');
    const file = await request.file();
    if (!file) badRequest('Missing receipt file');
    const chunks: Buffer[] = [];
    for await (const chunk of file.file) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const buffer = Buffer.concat(chunks);
    if (buffer.length === 0) badRequest('The file is empty');
    const fileSha256 = sha256Buffer(buffer);

    // Same bytes already in Ledger: reuse that receipt rather than storing a duplicate.
    const duplicate = await db.query.receipts.findFirst({ where: eq(receipts.fileSha256, fileSha256) });
    if (duplicate?.transactionId && duplicate.transactionId !== transaction.id) {
      conflict('This file is already attached to another transaction', { receiptId: duplicate.id, transactionId: duplicate.transactionId });
    }
    let receiptId = duplicate?.id;
    let processing = false;
    if (!receiptId) {
      const safeName = sanitizeFileName(file.filename || 'receipt');
      const key = `receipts/upload/${new Date().toISOString().slice(0, 10)}/${randomUUID().slice(0, 8)}-${safeName}`;
      await storage().put({ key, body: buffer, contentType: file.mimetype });
      const [created] = await db.insert(receipts).values({
        businessId: transaction.businessId,
        source: 'upload',
        status: 'pending',
        fileKey: key,
        fileName: safeName,
        mimeType: file.mimetype,
        fileSha256,
        uploadedByUserId: user.id,
        ocrJson: { attachedFromTransactionId: transaction.id },
      }).returning({ id: receipts.id });
      receiptId = created.id;
      processing = true;
    }

    const paired = await attachReceipt(transaction.id, receiptId, {
      mode: 'manual',
      score: 1,
      reasons: { manualPair: true, via: 'transaction_upload' },
    });
    if (!paired) notFound('Transaction not found');
    // Extract after pairing: the matcher skips it (already paired); extraction fills the details
    // and re-runs the category evidence review.
    if (processing) await enqueue('receipt.extract', { receiptId });
    await audit(request, user, 'upload_receipt_to_transaction', 'transaction', transaction.id, { receiptId, reused: !processing });
    const [row, receipt] = await Promise.all([transactionRow(transaction.id), receiptRow(receiptId)]);
    return {
      transaction: row ? apiTransaction(row) : null,
      receipt: receipt ? toApiReceipt(receipt) : null,
      processing,
    };
  });

  app.post('/transactions/:id/receipt/find-in-gmail', async (request) => {
    const user = await requireUser(request);
    const params = z.object({ id: uuid }).parse(request.params);
    const result = await findTransactionReceiptInGmail(params.id);
    if (!result) notFound('Transaction not found');
    await audit(request, user, 'find_receipt_in_gmail', 'transaction', params.id, {
      query: result.search.query,
      hits: result.hits.length,
      paired: result.paired,
    });
    return {
      search: result.search,
      searchable: result.searchable,
      mailboxes: result.mailboxes,
      hits: result.hits.map((hit) => ({
        receipt: toApiReceipt(hit.receipt),
        status: hit.status,
        isNew: hit.isNew,
        score: hit.score,
        explanations: hit.explanations,
      })),
      paired: result.paired,
      transaction: apiTransaction(result.transaction),
    };
  });

  app.post('/transactions/:id/receipt/waive', async (request) => {
    const user = await requireUser(request);
    const params = z.object({ id: uuid }).parse(request.params);
    const body = z.object({
      alwaysForMerchant: z.boolean().default(false),
      thisBusinessOnly: z.boolean().default(false),
      note: z.string().trim().max(300).nullable().optional(),
    }).parse(request.body ?? {});
    try {
      const result = await waiveTransaction({ transactionId: params.id, userId: user.id, ...body });
      if (!result) notFound('Transaction not found');
      await audit(request, user, 'waive_receipt', 'transaction', params.id, { ...body, ruleId: result.rule?.id, alsoWaived: result.alsoWaived });
      const row = await transactionRow(params.id);
      return {
        transaction: row ? apiTransaction(row) : null,
        rule: result.rule ? toApiWaiverRule(result.rule, describeWaiverRule(result.rule)) : null,
        alsoWaived: result.alsoWaived,
      };
    } catch (error) {
      rethrowWaiverError(error);
    }
  });

  app.get('/transactions/:id/receipt/waiver', async (request) => {
    await requireUser(request);
    const params = z.object({ id: uuid }).parse(request.params);
    return { evidence: await waiverEvidenceFor(params.id, await getReceiptTrackingSince()) };
  });

  app.delete('/transactions/:id/receipt/waiver', async (request) => {
    const user = await requireUser(request);
    const params = z.object({ id: uuid }).parse(request.params);
    const updated = await unwaiveTransaction(params.id);
    if (!updated) badRequest('Transaction is not waived');
    await audit(request, user, 'unwaive_receipt', 'transaction', params.id);
    const row = await transactionRow(params.id);
    return { transaction: row ? apiTransaction(row) : null };
  });
}
