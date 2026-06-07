import crypto from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '../db/client.js';
import { categories, categoryRules, receipts, transactions } from '../db/schema.js';
import { audit } from './audit.js';
import {
  formatCentsDetailed,
  receiptArtifact,
  receiptById,
  transactionArtifact,
} from './assistantArtifacts.js';
import {
  ASSISTANT_MUTATION_LIMIT,
  type AssistantReceiptUpdatePayload,
  signAssistantToken,
  verifyAssistantToken,
} from './assistantSecurity.js';
import type { ConfirmAssistantActionResult, AssistantToolContext, AssistantToolResult } from './assistantToolTypes.js';
import {
  bulkTransactionUpdateSchema,
  categoryRuleSchema,
  receiptPairingSchema,
  receiptUpdateSchema,
  transactionUpdateSchema,
} from './assistantToolDefinitions.js';
import type { AssistantApprovalRequest } from './assistantSchemas.js';
import { resolveBusiness, resolveCategoryId } from './assistantQueryHelpers.js';
import { attachReceipt } from './matching.js';

export async function confirmAssistantAction(
  token: string,
  context: AssistantToolContext,
): Promise<ConfirmAssistantActionResult> {
  const envelope = verifyAssistantToken(token, context.user.id);
  if (!envelope) throw new Error('This approval expired or is invalid. Ask the assistant to prepare it again.');
  const payload = envelope.payload;
  if (payload.kind === 'data_expansion') {
    return { ok: true, message: 'Expanded data approved for the next assistant request.' };
  }
  if (payload.kind === 'transaction_update') {
    const update = transactionUpdatePayload(payload);
    const [row] = await db.update(transactions).set(update).where(eq(transactions.id, payload.transactionId)).returning();
    if (!row) throw new Error('Transaction not found.');
    await audit(context.request!, context.user, 'assistant_update_transaction', 'transaction', payload.transactionId, redactPayload(payload));
    return {
      ok: true,
      message: 'Transaction updated.',
      artifact: await transactionArtifact([payload.transactionId], 'Updated transaction'),
    };
  }
  if (payload.kind === 'bulk_transaction_update') {
    if (payload.transactionIds.length > ASSISTANT_MUTATION_LIMIT) throw new Error('Bulk update exceeds assistant limit.');
    const update = transactionUpdatePayload(payload);
    await db.update(transactions).set(update).where(inArray(transactions.id, payload.transactionIds));
    await audit(context.request!, context.user, 'assistant_bulk_update_transactions', 'transaction', undefined, {
      count: payload.transactionIds.length,
      ...redactPayload(payload),
    });
    return {
      ok: true,
      message: `Updated ${payload.transactionIds.length} transactions.`,
      artifact: await transactionArtifact(payload.transactionIds, 'Updated transactions'),
    };
  }
  if (payload.kind === 'category_rule') {
    const [rule] = await db.insert(categoryRules).values({
      businessId: payload.businessId ?? null,
      categoryId: payload.categoryId,
      matchKind: payload.matchKind,
      pattern: normalizeRulePattern(payload.pattern),
      priority: payload.priority,
      createdByAi: true,
    }).returning();
    await audit(context.request!, context.user, 'assistant_create_category_rule', 'category_rule', rule.id, redactPayload(payload));
    return { ok: true, message: 'Category rule created.' };
  }
  if (payload.kind === 'receipt_update') {
    await applyReceiptUpdates(payload.receiptId, payload.updates);
    await audit(context.request!, context.user, 'assistant_update_receipt', 'receipt', payload.receiptId, redactPayload(payload));
    return {
      ok: true,
      message: 'Receipt details updated.',
      artifact: await receiptArtifact([payload.receiptId], 'Updated receipt'),
    };
  }
  if (payload.kind === 'receipt_pairing') {
    await confirmReceiptPairing(payload.receiptId, payload.transactionId, payload.updates);
    await audit(context.request!, context.user, 'assistant_pair_receipt', 'receipt', payload.receiptId, redactPayload(payload));
    return {
      ok: true,
      message: 'Receipt paired to transaction.',
      artifact: await transactionArtifact([payload.transactionId], 'Paired transaction'),
    };
  }
  return { ok: false, message: 'Unsupported approval payload.' };
}

export async function proposeTransactionUpdate(args: z.infer<typeof transactionUpdateSchema>, userId: string): Promise<AssistantToolResult> {
  const payload = await buildTransactionUpdatePayload(args);
  const approval = createApproval(userId, {
    kind: 'transaction_update',
    transactionId: args.transactionId,
    ...payload,
  }, 'Confirm transaction update', describeTransactionUpdate(payload, 1), 'Apply update');
  return { ok: true, message: 'Prepared transaction update for confirmation.', approvalRequests: [approval], data: { pendingMutation: payload } };
}

export async function proposeBulkTransactionUpdate(args: z.infer<typeof bulkTransactionUpdateSchema>, userId: string): Promise<AssistantToolResult> {
  const payload = await buildTransactionUpdatePayload(args);
  const approval = createApproval(userId, {
    kind: 'bulk_transaction_update',
    transactionIds: args.transactionIds,
    ...payload,
  }, 'Confirm bulk transaction update', describeTransactionUpdate(payload, args.transactionIds.length), `Update ${args.transactionIds.length} rows`);
  return { ok: true, message: 'Prepared bulk transaction update for confirmation.', approvalRequests: [approval], data: { pendingMutation: payload, count: args.transactionIds.length } };
}

export async function proposeCategoryRule(args: z.infer<typeof categoryRuleSchema>, userId: string): Promise<AssistantToolResult> {
  const business = await resolveBusiness(args.business ?? args.businessId ?? null);
  const category = await db.query.categories.findFirst({ where: eq(categories.id, args.categoryId) });
  if (!category) throw new Error('Category not found.');
  const approval = createApproval(userId, {
    kind: 'category_rule',
    businessId: business?.id ?? args.businessId ?? null,
    categoryId: args.categoryId,
    matchKind: args.matchKind,
    pattern: args.pattern,
    priority: args.priority,
  }, 'Confirm category rule', `Create ${args.matchKind} rule "${args.pattern}" for ${category.name}${business ? ` in ${business.name}` : ''}.`, 'Create rule');
  return { ok: true, message: 'Prepared category rule for confirmation.', approvalRequests: [approval] };
}

export async function proposeReceiptUpdate(args: z.infer<typeof receiptUpdateSchema>, userId: string): Promise<AssistantToolResult> {
  const receipt = await receiptById(args.receiptId);
  if (!receipt) throw new Error('Receipt not found.');
  const updates = receiptUpdatePayload(args);
  if (Object.keys(updates).length === 0) throw new Error('No receipt changes were provided.');
  const approval = createApproval(userId, {
    kind: 'receipt_update',
    receiptId: args.receiptId,
    updates,
  }, 'Confirm receipt update', describeReceiptUpdate(receipt, updates), 'Save receipt');
  return { ok: true, message: 'Prepared receipt update for confirmation.', approvalRequests: [approval], data: { pendingMutation: updates } };
}

export async function proposeReceiptPairing(args: z.infer<typeof receiptPairingSchema>, userId: string): Promise<AssistantToolResult> {
  const [receipt, transaction] = await Promise.all([
    receiptById(args.receiptId),
    db.query.transactions.findFirst({ where: eq(transactions.id, args.transactionId) }),
  ]);
  if (!receipt) throw new Error('Receipt not found.');
  if (!transaction) throw new Error('Transaction not found.');
  assertPairingAllowed(receipt, transaction);
  const updates = receiptUpdatePayload(args);
  const approval = createApproval(userId, {
    kind: 'receipt_pairing',
    receiptId: args.receiptId,
    transactionId: args.transactionId,
    updates: Object.keys(updates).length ? updates : undefined,
  }, 'Confirm receipt pairing', describeReceiptPairing(receipt, transaction, updates), 'Pair receipt');
  return {
    ok: true,
    message: 'Prepared receipt pairing for confirmation.',
    approvalRequests: [approval],
    data: { pendingMutation: { receiptId: args.receiptId, transactionId: args.transactionId, updates } },
  };
}

async function buildTransactionUpdatePayload(args: {
  categoryId?: string | null;
  categoryName?: string | null;
  businessId?: string | null;
  business?: string | null;
  note?: string | null;
}) {
  const business = await resolveBusiness(args.business ?? args.businessId ?? null);
  const categoryId = args.categoryName !== undefined
    ? await resolveCategoryId(args.categoryName, business?.id ?? args.businessId ?? null)
    : args.categoryId;
  if (categoryId) {
    const category = await db.query.categories.findFirst({ where: eq(categories.id, categoryId) });
    if (!category) throw new Error('Category not found.');
  }
  if (args.businessId && !business) throw new Error('Business not found.');
  if (categoryId === undefined && business?.id === undefined && args.note === undefined) {
    throw new Error('No transaction changes were provided.');
  }
  return {
    categoryId,
    businessId: business?.id ?? args.businessId,
    note: args.note,
  };
}

function transactionUpdatePayload(payload: {
  categoryId?: string | null;
  businessId?: string | null;
  note?: string | null;
}) {
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if ('categoryId' in payload) {
    update.categoryId = payload.categoryId ?? null;
    update.categorySource = payload.categoryId ? 'manual' : 'uncategorized';
    update.categoryConfidence = payload.categoryId ? '1.0000' : null;
    update.categoryEvidence = payload.categoryId ? { source: 'assistant_confirmed' } : {};
  }
  if ('businessId' in payload) update.businessId = payload.businessId ?? null;
  if ('note' in payload) update.note = payload.note ?? null;
  return update;
}

function receiptUpdatePayload(args: {
  setMerchant?: boolean;
  merchant?: string | null;
  setTotalCents?: boolean;
  totalCents?: number | null;
  setReceiptDate?: boolean;
  receiptDate?: string | null;
}): AssistantReceiptUpdatePayload {
  const updates: AssistantReceiptUpdatePayload = {};
  if (args.setMerchant) {
    if (!args.merchant) throw new Error('Receipt merchant must be provided when setMerchant is true.');
    updates.merchant = args.merchant;
  }
  if (args.setTotalCents) {
    if (args.totalCents == null) throw new Error('Receipt total must be provided when setTotalCents is true.');
    updates.totalCents = args.totalCents;
  }
  if (args.setReceiptDate) {
    if (!args.receiptDate) throw new Error('Receipt date must be provided when setReceiptDate is true.');
    updates.receiptDate = args.receiptDate;
  }
  return updates;
}

async function applyReceiptUpdates(receiptId: string, updates: AssistantReceiptUpdatePayload | undefined): Promise<void> {
  if (!updates || Object.keys(updates).length === 0) return;
  const [updated] = await db
    .update(receipts)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(receipts.id, receiptId))
    .returning({ id: receipts.id });
  if (!updated) throw new Error('Receipt not found.');
}

async function confirmReceiptPairing(
  receiptId: string,
  transactionId: string,
  updates: AssistantReceiptUpdatePayload | undefined,
): Promise<void> {
  const [receipt, transaction] = await Promise.all([
    receiptById(receiptId),
    db.query.transactions.findFirst({ where: eq(transactions.id, transactionId) }),
  ]);
  if (!receipt) throw new Error('Receipt not found.');
  if (!transaction) throw new Error('Transaction not found.');
  assertPairingAllowed(receipt, transaction);
  await applyReceiptUpdates(receiptId, updates);
  const paired = await attachReceipt(transactionId, receiptId);
  if (!paired) throw new Error('Transaction not found.');
}

function assertPairingAllowed(
  receipt: typeof receipts.$inferSelect,
  transaction: typeof transactions.$inferSelect,
): void {
  if (receipt.transactionId && receipt.transactionId !== transaction.id) throw new Error('Receipt is already matched to another transaction.');
  if (transaction.receiptId && transaction.receiptId !== receipt.id) throw new Error('Transaction already has another receipt attached.');
  if (receipt.businessId && receipt.businessId !== transaction.businessId) throw new Error('Receipt and transaction belong to different businesses.');
}

export function createApproval(
  userId: string,
  payload: Parameters<typeof signAssistantToken>[1],
  title: string,
  detail: string,
  buttonLabel: string,
): AssistantApprovalRequest {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
  return {
    id: crypto.randomUUID(),
    kind: payload.kind === 'data_expansion' ? 'data_expansion' as const : 'mutation' as const,
    title,
    detail,
    token: signAssistantToken(userId, payload, 15 * 60 * 1000, undefined, now),
    buttonLabel,
    expiresAt,
  };
}

function describeTransactionUpdate(payload: { categoryId?: string | null; businessId?: string | null; note?: string | null }, count: number): string {
  const parts = [];
  if ('categoryId' in payload) parts.push(payload.categoryId ? 'set category' : 'clear category');
  if ('businessId' in payload) parts.push(payload.businessId ? 'set business' : 'clear business');
  if ('note' in payload) parts.push(payload.note ? 'set note' : 'clear note');
  return `${parts.join(', ')} on ${count} transaction${count === 1 ? '' : 's'}.`;
}

function describeReceiptUpdate(
  receipt: typeof receipts.$inferSelect,
  updates: AssistantReceiptUpdatePayload,
): string {
  return `Update ${receiptLabel(receipt)}: ${describeReceiptUpdates(updates)}.`;
}

function describeReceiptPairing(
  receipt: typeof receipts.$inferSelect,
  transaction: typeof transactions.$inferSelect,
  updates: AssistantReceiptUpdatePayload,
): string {
  const receiptAmount = updates.totalCents ?? receipt.totalCents;
  const receiptDate = updates.receiptDate ?? receipt.receiptDate;
  const receiptMerchant = updates.merchant ?? receiptLabel(receipt);
  const corrections = Object.keys(updates).length ? ` Apply receipt corrections first: ${describeReceiptUpdates(updates)}.` : '';
  return `Pair ${receiptMerchant}${receiptDate ? ` from ${receiptDate}` : ''}${receiptAmount == null ? '' : ` for ${formatCentsDetailed(receiptAmount)}`} to ${transaction.merchant} ${formatCentsDetailed(transaction.amountCents)} on ${transaction.date}.${corrections}`;
}

function describeReceiptUpdates(updates: AssistantReceiptUpdatePayload): string {
  const parts = [];
  if ('merchant' in updates) parts.push(`set merchant to "${updates.merchant}"`);
  if ('totalCents' in updates && updates.totalCents != null) parts.push(`set total to ${formatCentsDetailed(updates.totalCents)}`);
  if ('receiptDate' in updates) parts.push(`set date to ${updates.receiptDate}`);
  return parts.join(', ') || 'no changes';
}

function receiptLabel(receipt: typeof receipts.$inferSelect): string {
  return receipt.merchant ?? receipt.fileName ?? 'receipt';
}

function redactPayload(payload: Record<string, unknown>) {
  const clone = { ...payload };
  delete clone.token;
  return clone;
}

function normalizeRulePattern(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
