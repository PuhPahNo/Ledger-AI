import path from 'node:path';
import { and, eq, gte, inArray, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  connections,
  qboAccounts,
  qboAttachments,
  qboCompanies,
  qboTransactionLinks,
  qboTransactions,
  qboVendors,
  receipts,
  transactions,
} from '../db/schema.js';
import { sha256Buffer } from '../lib/crypto.js';
import { enqueue, NonRetryableJobError } from '../jobs/queue.js';
import { attachReceipt } from './matching.js';
import { storage } from './storage.js';
import { QboReauthRequiredError, type FetchLike, type QboApiClient, type QboEntity } from './quickbooksClient.js';
import { emitQuickbooksCategorySignals, quickbooksApiClient } from './quickbooks.js';
import { runAutoLinking } from './quickbooksLinking.js';
import { applyAutoMappings } from './quickbooksMapping.js';
import {
  QBO_SYNC_ENTITIES,
  QBO_TRANSACTION_ENTITIES,
  attachableTransactionRef,
  isDeletedEntity,
  normalizeAccount,
  normalizeAttachable,
  normalizeTransaction,
  normalizeVendor,
  type QboTransactionEntity,
} from './quickbooksNormalize.js';

export const QBO_HISTORY_MONTHS = 24;
/** Intuit's CDC looks back at most 30 days; beyond that we re-query everything. */
export const QBO_CDC_MAX_LOOKBACK_DAYS = 29;
/** CDC returns at most 1000 objects per entity; a full page means "re-query that entity". */
export const QBO_CDC_ENTITY_CAP = 1000;
const CDC_OVERLAP_MS = 5 * 60 * 1000;
const ATTACHMENT_IMPORT_LIMIT = 100;
const IMPORTABLE_MIME = /^(application\/pdf|image\/(png|jpe?g|gif|webp|heic|heif))$/i;

export function historyStartDate(now = new Date(), months = QBO_HISTORY_MONTHS): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1));
  return d.toISOString().slice(0, 10);
}

export type SyncMode = 'full' | 'cdc';

export function chooseSyncMode(input: { lastCdcAt: Date | null; lastFullSyncAt: Date | null; forceFull?: boolean }, now = new Date()): SyncMode {
  if (input.forceFull || !input.lastCdcAt || !input.lastFullSyncAt) return 'full';
  const ageDays = (now.getTime() - input.lastCdcAt.getTime()) / 86_400_000;
  return ageDays > QBO_CDC_MAX_LOOKBACK_DAYS ? 'full' : 'cdc';
}

/** QBO query WHERE clause for one entity during a full pull. */
export function fullSyncWhere(entity: string, fromDate: string): string {
  if (entity === 'Account' || entity === 'Vendor') return 'Active IN (true, false)';
  if (entity === 'Attachable') return '';
  return `TxnDate >= '${fromDate}'`;
}

export interface QuickbooksSyncResult {
  mode: SyncMode;
  accounts: number;
  vendors: number;
  transactions: number;
  deleted: number;
  attachments: number;
  linksCreated: number;
  linksRemoved: number;
  receiptsImported: number;
  receiptsPaired: number;
  categorySuggestions: number;
  apiRequests: number;
}

export async function syncQuickbooksConnection(
  connectionId: string,
  options: { full?: boolean; fetchImpl?: FetchLike; now?: Date } = {},
): Promise<QuickbooksSyncResult | null> {
  const connection = await db.query.connections.findFirst({ where: eq(connections.id, connectionId) });
  const company = await db.query.qboCompanies.findFirst({ where: eq(qboCompanies.connectionId, connectionId) });
  if (!connection || connection.kind !== 'quickbooks' || !company || !company.active || connection.status === 'disconnected') return null;
  if (connection.status === 'reauth') throw new NonRetryableJobError('QuickBooks needs to be reconnected before it can sync.');

  const startedAt = options.now ?? new Date();
  await db.update(qboCompanies).set({ lastSyncStartedAt: startedAt, updatedAt: new Date() }).where(eq(qboCompanies.connectionId, connectionId));

  try {
    const client = await quickbooksApiClient(connectionId, { fetchImpl: options.fetchImpl });
    const mode = chooseSyncMode({ lastCdcAt: company.lastCdcAt, lastFullSyncAt: company.lastFullSyncAt, forceFull: options.full }, startedAt);
    const fromDate = company.historyStartDate && mode === 'cdc' ? company.historyStartDate : historyStartDate(startedAt);

    const info = await client.companyInfo().catch(() => null);
    const companyName = typeof info?.CompanyName === 'string' && info.CompanyName.trim() ? info.CompanyName.trim() : company.companyName;

    const entities = mode === 'full'
      ? await fetchFull(client, fromDate)
      : await fetchChanges(client, new Date(company.lastCdcAt!.getTime() - CDC_OVERLAP_MS));

    const counts = await persistEntities(connectionId, company.businessId, entities, mode === 'full' ? fromDate : null);
    const attachableUris = new Map<string, string>();
    for (const item of entities.get('Attachable') ?? []) {
      if (!isDeletedEntity(item) && typeof item.TempDownloadUri === 'string') attachableUris.set(String(item.Id), item.TempDownloadUri);
    }

    await applyAutoMappings(connectionId);
    const linking = await runAutoLinking(connectionId);
    const suggestions = await emitQuickbooksCategorySignals(linking.created.map((l) => l.transactionId));
    const imported = await importAttachments(connectionId, company.businessId, client, attachableUris);
    const paired = await pairImportedReceipts(connectionId);

    const [{ count: txnCount }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(qboTransactions)
      .where(and(eq(qboTransactions.connectionId, connectionId), eq(qboTransactions.deleted, false)));

    const result: QuickbooksSyncResult = {
      mode,
      ...counts,
      linksCreated: linking.created.length,
      linksRemoved: linking.removedStale,
      receiptsImported: imported,
      receiptsPaired: paired,
      categorySuggestions: suggestions.length,
      apiRequests: client.requestCount,
    };
    const finishedAt = new Date();
    await db.update(qboCompanies).set({
      companyName,
      historyStartDate: mode === 'full' ? fromDate : company.historyStartDate ?? fromDate,
      lastCdcAt: startedAt,
      ...(mode === 'full' ? { lastFullSyncAt: startedAt } : {}),
      lastSyncError: null,
      lastSyncStats: { ...result, finishedAt: finishedAt.toISOString() },
      updatedAt: finishedAt,
    }).where(eq(qboCompanies.connectionId, connectionId));
    await db.update(connections).set({
      label: companyName ?? connection.label,
      lastSyncAt: finishedAt,
      syncedTransactionCount: Number(txnCount ?? 0),
      updatedAt: finishedAt,
    }).where(eq(connections.id, connectionId));
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(qboCompanies).set({ lastSyncError: message.slice(0, 500), updatedAt: new Date() }).where(eq(qboCompanies.connectionId, connectionId));
    if (error instanceof QboReauthRequiredError) throw new NonRetryableJobError(message);
    throw error;
  }
}

async function fetchFull(client: QboApiClient, fromDate: string): Promise<Map<string, QboEntity[]>> {
  const out = new Map<string, QboEntity[]>();
  for (const entity of QBO_SYNC_ENTITIES) {
    out.set(entity, await client.queryAll(entity, fullSyncWhere(entity, fromDate)));
  }
  return out;
}

async function fetchChanges(client: QboApiClient, since: Date): Promise<Map<string, QboEntity[]>> {
  const cdc = await client.cdc([...QBO_SYNC_ENTITIES], since);
  for (const entity of QBO_SYNC_ENTITIES) {
    const items = cdc.entities.get(entity) ?? [];
    // A capped CDC page may have dropped changes: re-query that entity by LastUpdatedTime.
    // (Deletions can't be queried; the next full sync reconciles those.)
    if (items.length >= QBO_CDC_ENTITY_CAP) {
      const requeried = await client.queryAll(entity, `MetaData.LastUpdatedTime >= '${since.toISOString()}'`);
      const deleted = items.filter(isDeletedEntity);
      cdc.entities.set(entity, [...requeried, ...deleted]);
    }
  }
  return cdc.entities;
}

async function persistEntities(
  connectionId: string,
  businessId: string,
  entities: Map<string, QboEntity[]>,
  fullSyncFromDate: string | null,
): Promise<{ accounts: number; vendors: number; transactions: number; deleted: number; attachments: number }> {
  const now = new Date();
  let deleted = 0;

  // Accounts
  const accountItems = entities.get('Account') ?? [];
  for (const item of accountItems) {
    if (isDeletedEntity(item)) {
      deleted += 1;
      await db.update(qboAccounts).set({ deleted: true, updatedAt: now })
        .where(and(eq(qboAccounts.connectionId, connectionId), eq(qboAccounts.qboId, String(item.Id))));
      continue;
    }
    const n = normalizeAccount(item);
    await db.insert(qboAccounts).values({ connectionId, ...n, deleted: false })
      .onConflictDoUpdate({
        target: [qboAccounts.connectionId, qboAccounts.qboId],
        set: { ...n, deleted: false, updatedAt: now },
      });
  }

  // Vendors
  const vendorItems = entities.get('Vendor') ?? [];
  for (const item of vendorItems) {
    if (isDeletedEntity(item)) {
      deleted += 1;
      await db.update(qboVendors).set({ deleted: true, updatedAt: now })
        .where(and(eq(qboVendors.connectionId, connectionId), eq(qboVendors.qboId, String(item.Id))));
      continue;
    }
    const n = normalizeVendor(item);
    await db.insert(qboVendors).values({ connectionId, ...n, deleted: false })
      .onConflictDoUpdate({ target: [qboVendors.connectionId, qboVendors.qboId], set: { ...n, deleted: false, updatedAt: now } });
  }

  // Transactions
  let txnCount = 0;
  for (const entityType of QBO_TRANSACTION_ENTITIES) {
    const items = entities.get(entityType) ?? [];
    const seen: string[] = [];
    for (const item of items) {
      if (isDeletedEntity(item)) {
        deleted += 1;
        await markTransactionDeleted(connectionId, entityType, String(item.Id), now);
        continue;
      }
      const n = normalizeTransaction(entityType, item);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(n.txnDate)) continue;
      seen.push(n.qboId);
      txnCount += 1;
      await db.insert(qboTransactions).values({ connectionId, businessId, ...n, deleted: false })
        .onConflictDoUpdate({
          target: [qboTransactions.connectionId, qboTransactions.entityType, qboTransactions.qboId],
          set: { ...n, businessId, deleted: false, updatedAt: now },
        });
    }
    // Full pull: anything in the window we didn't see was deleted in QuickBooks.
    if (fullSyncFromDate) {
      const missing = await db
        .select({ qboId: qboTransactions.qboId })
        .from(qboTransactions)
        .where(and(
          eq(qboTransactions.connectionId, connectionId),
          eq(qboTransactions.entityType, entityType),
          eq(qboTransactions.deleted, false),
          gte(qboTransactions.txnDate, fullSyncFromDate),
          seen.length ? notInArray(qboTransactions.qboId, seen) : sql`true`,
        ));
      for (const row of missing) {
        deleted += 1;
        await markTransactionDeleted(connectionId, entityType, row.qboId, now);
      }
    }
  }

  // Attachables (metadata only here; files are imported afterwards)
  const attachableItems = entities.get('Attachable') ?? [];
  let attachmentCount = 0;
  for (const item of attachableItems) {
    if (isDeletedEntity(item)) {
      deleted += 1;
      await db.update(qboAttachments).set({ deleted: true, updatedAt: now })
        .where(and(eq(qboAttachments.connectionId, connectionId), eq(qboAttachments.qboId, String(item.Id))));
      continue;
    }
    const n = normalizeAttachable(item);
    const txnRef = attachableTransactionRef(n.entityRefs);
    const qboTxn = txnRef
      ? await db.query.qboTransactions.findFirst({
        where: and(
          eq(qboTransactions.connectionId, connectionId),
          eq(qboTransactions.entityType, txnRef.type),
          eq(qboTransactions.qboId, txnRef.value),
        ),
      })
      : undefined;
    const values = {
      fileName: n.fileName,
      contentType: n.contentType,
      sizeBytes: n.sizeBytes,
      note: n.note,
      entityRefs: n.entityRefs,
      qboTransactionId: qboTxn?.id ?? null,
      syncToken: n.syncToken,
      qboUpdatedAt: n.qboUpdatedAt,
      deleted: false,
    };
    attachmentCount += 1;
    await db.insert(qboAttachments).values({ connectionId, qboId: n.qboId, ...values })
      .onConflictDoUpdate({ target: [qboAttachments.connectionId, qboAttachments.qboId], set: { ...values, updatedAt: now } });
  }

  // Attachables that arrived before the transaction they belong to.
  await db.execute(sql`
    WITH m AS (
      SELECT a.id, (
        SELECT t.id FROM jsonb_array_elements(a.entity_refs) r
        JOIN qbo_transactions t ON t.connection_id = a.connection_id AND t.entity_type = r->>'type' AND t.qbo_id = r->>'value'
        LIMIT 1
      ) AS txn_id
      FROM qbo_attachments a
      WHERE a.connection_id = ${connectionId}::uuid AND a.qbo_transaction_id IS NULL AND NOT a.deleted
    )
    UPDATE qbo_attachments x SET qbo_transaction_id = m.txn_id, updated_at = now()
    FROM m WHERE x.id = m.id AND m.txn_id IS NOT NULL`);

  return { accounts: accountItems.length, vendors: vendorItems.length, transactions: txnCount, deleted, attachments: attachmentCount };
}

async function markTransactionDeleted(connectionId: string, entityType: QboTransactionEntity, qboId: string, now: Date): Promise<void> {
  await db.update(qboTransactions).set({ deleted: true, updatedAt: now })
    .where(and(eq(qboTransactions.connectionId, connectionId), eq(qboTransactions.entityType, entityType), eq(qboTransactions.qboId, qboId)));
}

// ---------------------------------------------------------------------------------------------
// Attachments → receipts
// ---------------------------------------------------------------------------------------------

export function sanitizeAttachmentFileName(fileName: string | null | undefined, fallback: string): string {
  const parsed = path.parse(fileName || fallback);
  const base = parsed.name.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 80) || 'receipt';
  const ext = parsed.ext.replace(/[^a-z0-9.]+/gi, '').slice(0, 12);
  return `${base}${ext}`;
}

export function quickbooksReceiptStorageKey(input: { connectionId: string; attachableId: string; fileName: string; contentSha256: string }): string {
  return `receipts/quickbooks/${input.connectionId}/${input.attachableId}/${input.contentSha256.slice(0, 16)}-${input.fileName}`;
}

export type AttachmentImportDecision =
  | { action: 'skip'; reason: string }
  | { action: 'reuse'; receiptId: string }
  | { action: 'import' };

/**
 * Pure dedupe decision. An attachable imports once (tracked by its qbo id row); identical bytes
 * already in Ledger (any source, same business) are reused instead of creating a second receipt.
 */
export function decideAttachmentImport(input: {
  alreadyImportedReceiptId: string | null;
  contentType: string | null;
  existingReceiptWithSameSha: { id: string; businessId: string | null } | null;
  businessId: string;
}): AttachmentImportDecision {
  if (input.alreadyImportedReceiptId) return { action: 'skip', reason: 'already_imported' };
  if (!input.contentType || !IMPORTABLE_MIME.test(input.contentType)) return { action: 'skip', reason: 'unsupported_type' };
  if (input.existingReceiptWithSameSha && (input.existingReceiptWithSameSha.businessId === input.businessId || input.existingReceiptWithSameSha.businessId == null)) {
    return { action: 'reuse', receiptId: input.existingReceiptWithSameSha.id };
  }
  return { action: 'import' };
}

async function importAttachments(
  connectionId: string,
  businessId: string,
  client: QboApiClient,
  tempUris: Map<string, string>,
): Promise<number> {
  const pending = await db.select().from(qboAttachments).where(and(
    eq(qboAttachments.connectionId, connectionId),
    eq(qboAttachments.deleted, false),
    isNotNull(qboAttachments.qboTransactionId),
    isNull(qboAttachments.receiptId),
    inArray(qboAttachments.importStatus, ['pending', 'failed']),
  )).limit(ATTACHMENT_IMPORT_LIMIT);

  let imported = 0;
  for (const attachment of pending) {
    const early = decideAttachmentImport({ alreadyImportedReceiptId: attachment.receiptId, contentType: attachment.contentType, existingReceiptWithSameSha: null, businessId });
    if (early.action === 'skip') {
      await db.update(qboAttachments).set({ importStatus: 'skipped', importError: early.reason, updatedAt: new Date() }).where(eq(qboAttachments.id, attachment.id));
      continue;
    }
    try {
      const buffer = await client.downloadAttachable({ Id: attachment.qboId, TempDownloadUri: tempUris.get(attachment.qboId) });
      const fileSha256 = sha256Buffer(buffer);
      const existing = await db.query.receipts.findFirst({
        where: and(eq(receipts.fileSha256, fileSha256), or(eq(receipts.businessId, businessId), isNull(receipts.businessId))),
      });
      const decision = decideAttachmentImport({
        alreadyImportedReceiptId: null,
        contentType: attachment.contentType,
        existingReceiptWithSameSha: existing ? { id: existing.id, businessId: existing.businessId } : null,
        businessId,
      });
      if (decision.action === 'reuse') {
        await db.update(qboAttachments).set({ receiptId: decision.receiptId, fileSha256, importStatus: 'duplicate', importError: null, updatedAt: new Date() })
          .where(eq(qboAttachments.id, attachment.id));
        continue;
      }
      if (decision.action === 'skip') continue;

      const qboTxn = await db.query.qboTransactions.findFirst({ where: eq(qboTransactions.id, attachment.qboTransactionId!) });
      const fileName = sanitizeAttachmentFileName(attachment.fileName, `quickbooks-${attachment.qboId}`);
      const key = quickbooksReceiptStorageKey({ connectionId, attachableId: attachment.qboId, fileName, contentSha256: fileSha256 });
      await storage().put({ key, body: buffer, contentType: attachment.contentType ?? 'application/octet-stream' });
      const [receipt] = await db.insert(receipts).values({
        businessId,
        source: 'quickbooks',
        status: 'pending',
        fileKey: key,
        fileName,
        mimeType: attachment.contentType,
        fileSha256,
        ocrJson: {
          source: 'quickbooks',
          qboAttachableId: attachment.qboId,
          qboTransaction: qboTxn ? {
            id: qboTxn.id,
            entityType: qboTxn.entityType,
            qboId: qboTxn.qboId,
            payee: qboTxn.payeeName,
            totalCents: qboTxn.totalCents,
            txnDate: qboTxn.txnDate,
            docNumber: qboTxn.docNumber,
          } : null,
        },
      }).returning({ id: receipts.id });
      await db.update(qboAttachments).set({ receiptId: receipt.id, fileSha256, importStatus: 'imported', importError: null, updatedAt: new Date() })
        .where(eq(qboAttachments.id, attachment.id));
      imported += 1;
      // Pair first (if linked) so the extraction's matcher sees an already-matched receipt.
      await pairReceiptWithLinkedTransaction(receipt.id, attachment.qboTransactionId!, attachment.qboId);
      await enqueue('receipt.extract', { receiptId: receipt.id });
    } catch (error) {
      await db.update(qboAttachments).set({
        importStatus: 'failed',
        importError: (error instanceof Error ? error.message : String(error)).slice(0, 300),
        updatedAt: new Date(),
      }).where(eq(qboAttachments.id, attachment.id));
    }
  }
  return imported;
}

/**
 * A QuickBooks attachment on a linked QBO transaction IS that transaction's receipt: pair it as
 * a manual-quality pair — but only into an empty slot, never replacing a receipt already there.
 */
async function pairReceiptWithLinkedTransaction(receiptId: string, qboTransactionId: string, qboAttachableId: string): Promise<boolean> {
  const [link] = await db
    .select({ transactionId: qboTransactionLinks.transactionId, receiptId: transactions.receiptId })
    .from(qboTransactionLinks)
    .innerJoin(transactions, eq(qboTransactionLinks.transactionId, transactions.id))
    .where(and(eq(qboTransactionLinks.qboTransactionId, qboTransactionId), eq(qboTransactionLinks.status, 'linked')))
    .limit(1);
  if (!link || link.receiptId) return false;
  const receipt = await db.query.receipts.findFirst({ where: eq(receipts.id, receiptId) });
  if (!receipt || receipt.transactionId || receipt.status !== 'pending') return false;
  const attached = await attachReceipt(link.transactionId, receiptId, {
    mode: 'manual',
    score: 1,
    reasons: { source: 'quickbooks', qboTransactionId, qboAttachableId, linkedViaQuickbooks: true },
  });
  return Boolean(attached);
}

/** Receipts imported before their QBO transaction got linked: pair them now. */
async function pairImportedReceipts(connectionId: string): Promise<number> {
  const rows = await db
    .select({ receiptId: qboAttachments.receiptId, qboTransactionId: qboAttachments.qboTransactionId, qboId: qboAttachments.qboId })
    .from(qboAttachments)
    .innerJoin(receipts, eq(qboAttachments.receiptId, receipts.id))
    .where(and(
      eq(qboAttachments.connectionId, connectionId),
      eq(qboAttachments.deleted, false),
      isNotNull(qboAttachments.qboTransactionId),
      isNull(receipts.transactionId),
      eq(receipts.status, 'pending'),
    ))
    .limit(ATTACHMENT_IMPORT_LIMIT);
  let paired = 0;
  for (const row of rows) {
    if (await pairReceiptWithLinkedTransaction(row.receiptId!, row.qboTransactionId!, row.qboId)) paired += 1;
  }
  return paired;
}

/** Re-run mappings + linking without calling QuickBooks (after a mapping change). */
export async function relinkQuickbooksConnection(connectionId: string): Promise<{ linksCreated: number; linksRemoved: number; receiptsPaired: number }> {
  await applyAutoMappings(connectionId);
  const linking = await runAutoLinking(connectionId);
  // A mapping change can alter the suggestion for records that were linked long ago, so
  // re-send signals for every linked transaction (review items dedupe by fingerprint).
  const linked = await db
    .select({ transactionId: qboTransactionLinks.transactionId })
    .from(qboTransactionLinks)
    .innerJoin(qboTransactions, eq(qboTransactionLinks.qboTransactionId, qboTransactions.id))
    .where(and(eq(qboTransactions.connectionId, connectionId), eq(qboTransactionLinks.status, 'linked')));
  await emitQuickbooksCategorySignals([...new Set(linked.map((row) => row.transactionId))]);
  const paired = await pairImportedReceipts(connectionId);
  return { linksCreated: linking.created.length, linksRemoved: linking.removedStale, receiptsPaired: paired };
}
