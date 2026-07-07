import { asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  tagRules,
  tags,
  transactionTags,
  transactions,
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

/**
 * Merchant-only cousin of categorization's ruleMatches: both sides go through the same
 * normalize() (processor prefixes like "SQ *" / "TST*" / "PAYPAL *" stripped, lowercased)
 * so a tag rule learned from one descriptor style matches the others.
 */
export function tagRuleMatches(rule: Pick<TagRule, 'matchKind' | 'pattern'>, merchant: string): boolean {
  const normalizedMerchant = normalize(merchant);
  const pattern = normalize(rule.pattern);
  if (!pattern) return false;
  if (rule.matchKind === 'merchant_contains') return normalizedMerchant.includes(pattern);
  if (rule.matchKind === 'merchant_exact') return normalizedMerchant === pattern;
  return false;
}

/**
 * Evaluate every active tag's rules against one transaction's merchant and insert any
 * missing links with source 'auto'. Existing rows (manual or auto) are left untouched —
 * ON CONFLICT DO NOTHING means a manual tag is never downgraded and nothing duplicates.
 */
export async function applyTagRulesToTransaction(txOrId: Transaction | string): Promise<void> {
  const txn = typeof txOrId === 'string'
    ? await db.query.transactions.findFirst({ where: eq(transactions.id, txOrId) })
    : txOrId;
  if (!txn) return;

  const rules = await activeTagRules();
  const matchedTagIds = new Set<string>();
  for (const rule of rules) {
    if (tagRuleMatches(rule, txn.merchant)) matchedTagIds.add(rule.tagId);
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

/**
 * Bulk-apply one tag's rules across all existing transactions. Matching happens in JS
 * against the distinct merchant list (small cardinality) so history uses the exact same
 * normalize() as the per-transaction sync path; the insert itself is one set-based
 * INSERT ... SELECT with ON CONFLICT DO NOTHING. Returns the number of newly tagged
 * transactions (manual tags are never touched).
 */
export async function applyTagRulesToHistory(tagId: string): Promise<number> {
  const rules = await db.select().from(tagRules).where(eq(tagRules.tagId, tagId));
  if (rules.length === 0) return 0;

  const merchants = await db.selectDistinct({ merchant: transactions.merchant }).from(transactions);
  const matched = merchants
    .map((row) => row.merchant)
    .filter((merchant) => rules.some((rule) => tagRuleMatches(rule, merchant)));
  if (matched.length === 0) return 0;

  const result = await db.execute(sql`
    INSERT INTO transaction_tags (transaction_id, tag_id, source)
    SELECT ${transactions.id}, ${tagId}::uuid, 'auto'
    FROM ${transactions}
    WHERE ${inArray(transactions.merchant, matched)}
    ON CONFLICT DO NOTHING
  `);
  return result.rowCount ?? 0;
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
