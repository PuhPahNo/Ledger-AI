import { asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  categories,
  receipts,
  tagRules,
  tags,
  transactionTags,
  transactions,
  type Receipt,
  type TagRule,
  type Transaction,
  type TransactionTagSource,
} from '../db/schema.js';
import { normalize } from './categorization.js';

/** Tag shape attached to API transaction payloads. */
export interface ApiTransactionTag {
  id: string;
  name: string;
  color: string;
  source: TransactionTagSource;
}

export interface TagRuleContext {
  merchant: string;
  categoryName?: string | null;
  receiptText?: string | null;
}

/**
 * Match a tag rule against the transaction facts available at that point in the
 * automation lifecycle. A string remains accepted for the merchant-only call sites and
 * tests that predate richer category/receipt rules.
 */
export function tagRuleMatches(
  rule: Pick<TagRule, 'matchKind' | 'pattern'>,
  input: TagRuleContext | string,
): boolean {
  const context = typeof input === 'string' ? { merchant: input } : input;
  const pattern = normalize(rule.pattern);
  if (!pattern) return false;
  const merchant = normalize(context.merchant);
  if (rule.matchKind === 'merchant_contains') return merchant.includes(pattern);
  if (rule.matchKind === 'merchant_exact') return merchant === pattern;
  if (rule.matchKind === 'category_exact') return normalize(context.categoryName ?? '') === pattern;
  if (rule.matchKind === 'receipt_contains') return normalize(context.receiptText ?? '').includes(pattern);
  return false;
}

/**
 * Evaluate every active tag's rules against one transaction and insert any missing links
 * with source 'auto'. Category and receipt data are loaded only when an active rule needs
 * them. Existing rows are left untouched, so manual tags are never downgraded.
 */
export async function applyTagRulesToTransaction(txOrId: Transaction | string): Promise<void> {
  const txn = typeof txOrId === 'string'
    ? await db.query.transactions.findFirst({ where: eq(transactions.id, txOrId) })
    : txOrId;
  if (!txn) return;

  const rules = await activeTagRules();
  if (rules.length === 0) return;
  const needsCategory = rules.some((rule) => rule.matchKind === 'category_exact');
  const needsReceipt = rules.some((rule) => rule.matchKind === 'receipt_contains');
  const [category, receipt] = await Promise.all([
    needsCategory && txn.categoryId
      ? db.query.categories.findFirst({ where: eq(categories.id, txn.categoryId) })
      : null,
    needsReceipt && txn.receiptId
      ? db.query.receipts.findFirst({ where: eq(receipts.id, txn.receiptId) })
      : null,
  ]);
  const context: TagRuleContext = {
    merchant: txn.merchant,
    categoryName: category?.name,
    receiptText: receipt ? receiptSearchText(receipt) : null,
  };
  const matchedTagIds = new Set<string>();
  for (const rule of rules) {
    if (tagRuleMatches(rule, context)) matchedTagIds.add(rule.tagId);
  }
  if (matchedTagIds.size === 0) return;

  await db
    .insert(transactionTags)
    .values(Array.from(matchedTagIds, (tagId) => ({
      transactionId: txn.id,
      tagId,
      source: 'auto' as const,
    })))
    .onConflictDoNothing();
}

/** Keep category/receipt automation successful if a secondary tag rule ever fails. */
export async function applyTagRulesBestEffort(txOrId: Transaction | string): Promise<void> {
  try {
    await applyTagRulesToTransaction(txOrId);
  } catch (error) {
    const transactionId = typeof txOrId === 'string' ? txOrId : txOrId.id;
    console.error(`Tag rules failed for transaction ${transactionId}`, error);
  }
}

/**
 * Bulk-apply one tag's rules across all existing transactions. This intentionally uses the
 * same context matcher as the live path so category and receipt rules cannot drift from
 * history behavior. Inserts are chunked and conflict-safe; manual tags are never touched.
 */
export async function applyTagRulesToHistory(tagId: string): Promise<number> {
  const rules = await db.select().from(tagRules).where(eq(tagRules.tagId, tagId));
  if (rules.length === 0) return 0;

  const rows = await db
    .select({
      transactionId: transactions.id,
      merchant: transactions.merchant,
      categoryName: categories.name,
      receiptMerchant: receipts.merchant,
      receiptFileName: receipts.fileName,
      receiptOcrJson: receipts.ocrJson,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(receipts, eq(transactions.receiptId, receipts.id));
  const matchedIds = rows
    .filter((row) => rules.some((rule) => tagRuleMatches(rule, {
      merchant: row.merchant,
      categoryName: row.categoryName,
      receiptText: receiptSearchText({
        merchant: row.receiptMerchant,
        fileName: row.receiptFileName,
        ocrJson: row.receiptOcrJson ?? {},
      }),
    })))
    .map((row) => row.transactionId);

  let tagged = 0;
  for (let index = 0; index < matchedIds.length; index += 500) {
    const inserted = await db
      .insert(transactionTags)
      .values(matchedIds.slice(index, index + 500).map((transactionId) => ({
        transactionId,
        tagId,
        source: 'auto' as const,
      })))
      .onConflictDoNothing()
      .returning({ transactionId: transactionTags.transactionId });
    tagged += inserted.length;
  }
  return tagged;
}

/**
 * Tags for a page of transactions in one grouped query (no N+1). Returns a map of
 * transactionId → tags ordered by tag name.
 */
export async function tagsByTransactionId(transactionIds: string[]): Promise<Map<string, ApiTransactionTag[]>> {
  const map = new Map<string, ApiTransactionTag[]>();
  if (transactionIds.length === 0) return map;
  const rows = await db
    .select({
      transactionId: transactionTags.transactionId,
      id: tags.id,
      name: tags.name,
      color: tags.color,
      source: transactionTags.source,
    })
    .from(transactionTags)
    .innerJoin(tags, eq(transactionTags.tagId, tags.id))
    .where(inArray(transactionTags.transactionId, transactionIds))
    .orderBy(asc(tags.name));
  for (const row of rows) {
    const list = map.get(row.transactionId) ?? [];
    list.push({ id: row.id, name: row.name, color: row.color, source: row.source });
    map.set(row.transactionId, list);
  }
  return map;
}

async function activeTagRules(): Promise<Array<Pick<TagRule, 'tagId' | 'matchKind' | 'pattern'>>> {
  return db
    .select({
      tagId: tagRules.tagId,
      matchKind: tagRules.matchKind,
      pattern: tagRules.pattern,
    })
    .from(tagRules)
    .innerJoin(tags, eq(tagRules.tagId, tags.id))
    .where(eq(tags.active, true));
}

function receiptSearchText(
  receipt: Pick<Receipt, 'merchant' | 'fileName' | 'ocrJson'>,
): string {
  const ocr = receipt.ocrJson ?? {};
  const lineItems = Array.isArray(ocr.lineItems)
    ? ocr.lineItems
    : Array.isArray(ocr.line_items) ? ocr.line_items : [];
  const lineItemText = lineItems.flatMap((item) => {
    if (typeof item === 'string') return [item];
    if (!item || typeof item !== 'object') return [];
    const description = (item as Record<string, unknown>).description;
    return typeof description === 'string' ? [description] : [];
  });
  return [
    receipt.merchant,
    receipt.fileName,
    ocr.categoryHint,
    ocr.category_hint,
    ocr.categoryEvidence,
    ocr.category_evidence,
    ocr.notes,
    ...lineItemText,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0).join(' ');
}
