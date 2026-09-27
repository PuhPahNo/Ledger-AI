import { and, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  accounts,
  categories,
  receiptWaiverRules,
  transactionReceiptWaivers,
  transactions,
  type ReceiptWaiverEvidenceKind,
  type ReceiptWaiverRule,
  type ReceiptWaiverRuleKind,
  type Transaction,
} from '../db/schema.js';
import { accountSpendFilter, categoryIsVisibleSpend } from '../routes/dashboard/helpers.js';

/**
 * "No receipt needed" rules. IRS guidance: receipts are generally not required for business
 * expenses under $75, except lodging. Three rule kinds, evaluated most-specific first:
 *   merchant  → a condensed merchant pattern (e.g. recurring SaaS)
 *   category  → one category id
 *   threshold → the single global "under $X" rule (seeded disabled at $75), optionally excluding
 *               travel/lodging spend
 * A matching outflow gets receipt status 'waived' plus a `transaction_receipt_waivers` row saying
 * which rule did it.
 */

export const DEFAULT_WAIVER_THRESHOLD_CENTS = 7500;
const MIN_MERCHANT_PATTERN_LENGTH = 3;

export interface WaiverRuleLike {
  id: string;
  kind: ReceiptWaiverRuleKind;
  enabled: boolean;
  businessId: string | null;
  thresholdCents: number | null;
  excludeLodging: boolean;
  merchantPattern: string | null;
  merchantLabel?: string | null;
  categoryId: string | null;
}

export interface WaiverSubject {
  amountCents: number;
  merchant: string;
  businessId: string;
  categoryId: string | null;
  categoryName?: string | null;
  categoryTaxCode?: string | null;
}

export interface WaiverMatch {
  ruleId: string;
  kind: ReceiptWaiverRuleKind;
  /** Human-readable, e.g. 'Under $75.00 (IRS threshold)'. */
  label: string;
}

// ---------------------------------------------------------------------------------------------
// Pure policy
// ---------------------------------------------------------------------------------------------

const processorPrefix = /^(sq|tst|sp|pp|paypal|py|dd|in|pos|ach|chk|debit|purchase)\s*\*\s*/i;

/**
 * Reduce a merchant / bank descriptor to comparable letters: processor prefixes ("SQ *"),
 * store numbers and other digit-bearing tokens, TLDs, and corporate suffixes are dropped.
 * "ADOBE *CREATIVE CLD" → "adobecreativecld"; "Adobe Inc." → "adobe".
 */
export function normalizeWaiverMerchant(value: string): string {
  return value
    .toLowerCase()
    .replace(processorPrefix, '')
    .replace(/\.(io|com|net|org|ai|app|co|gov|biz|us)\b/g, ' ')
    .replace(/\b[a-z]*\d[a-z0-9]*\b/g, ' ')
    .replace(/\b(inc|llc|ltd|co|corp|corporation|company|the|payment|payments|pymt|bill|subscription|www)\b/g, ' ')
    .replace(/[^a-z]+/g, '');
}

const lodgingCategoryPattern = /\b(travel|lodging|hotels?|accommodations?)\b/i;
const lodgingMerchantPattern = /\b(hotel|motel|inn|suites|resort|lodge|airbnb|vrbo|marriott|hilton|hyatt|sheraton|westin|ihg|holiday inn|hampton|courtyard|four seasons|ritz)\b/i;

/** Travel/lodging spend — the IRS $75 exception never applies to it. */
export function isLodgingSpend(subject: Pick<WaiverSubject, 'merchant' | 'categoryName' | 'categoryTaxCode'>): boolean {
  if (subject.categoryName && lodgingCategoryPattern.test(subject.categoryName)) return true;
  if (subject.categoryTaxCode && /travel|lodging/i.test(subject.categoryTaxCode)) return true;
  return lodgingMerchantPattern.test(subject.merchant);
}

function inScope(rule: WaiverRuleLike, subject: WaiverSubject): boolean {
  return rule.enabled && (!rule.businessId || rule.businessId === subject.businessId);
}

export function merchantRuleMatches(pattern: string | null, merchant: string): boolean {
  if (!pattern || pattern.length < MIN_MERCHANT_PATTERN_LENGTH) return false;
  const normalized = normalizeWaiverMerchant(merchant);
  return normalized.length > 0 && normalized.includes(pattern);
}

export function describeWaiverRule(rule: WaiverRuleLike, categoryName?: string | null): string {
  if (rule.kind === 'threshold') {
    const amount = formatCents(rule.thresholdCents ?? DEFAULT_WAIVER_THRESHOLD_CENTS);
    return `Under ${amount}${rule.excludeLodging ? ' (lodging excluded)' : ''}`;
  }
  if (rule.kind === 'merchant') return `Merchant: ${rule.merchantLabel || rule.merchantPattern}`;
  return `Category: ${categoryName ?? 'category'}`;
}

/**
 * The rule that waives this transaction's receipt, or null. Only outflows qualify. Merchant rules
 * win over category rules, which win over the global threshold (the most deliberate choice is the
 * evidence we show). Business-scoped rules only apply to their business.
 */
export function evaluateReceiptWaiver(
  subject: WaiverSubject,
  rules: WaiverRuleLike[],
  categoryNames: Map<string, string> = new Map(),
): WaiverMatch | null {
  if (subject.amountCents >= 0) return null;
  const active = rules.filter((rule) => inScope(rule, subject));

  const merchant = active.find((rule) => rule.kind === 'merchant' && merchantRuleMatches(rule.merchantPattern, subject.merchant));
  if (merchant) return { ruleId: merchant.id, kind: 'merchant', label: describeWaiverRule(merchant) };

  const category = subject.categoryId
    ? active.find((rule) => rule.kind === 'category' && rule.categoryId === subject.categoryId)
    : undefined;
  if (category) {
    return {
      ruleId: category.id,
      kind: 'category',
      label: describeWaiverRule(category, categoryNames.get(category.categoryId ?? '') ?? subject.categoryName),
    };
  }

  const threshold = active.find((rule) => rule.kind === 'threshold');
  if (threshold && threshold.thresholdCents && Math.abs(subject.amountCents) < threshold.thresholdCents) {
    if (threshold.excludeLodging && isLodgingSpend(subject)) return null;
    return { ruleId: threshold.id, kind: 'threshold', label: describeWaiverRule(threshold) };
  }
  return null;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// ---------------------------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------------------------

const RULE_CACHE_TTL_MS = 30_000;
let ruleCache: { rules: ReceiptWaiverRule[]; loadedAt: number } | null = null;

export function invalidateWaiverRuleCache(): void {
  ruleCache = null;
}

/** Enabled rules, cached briefly — the Plaid upsert path asks once per transaction. */
async function activeWaiverRules(): Promise<ReceiptWaiverRule[]> {
  if (ruleCache && Date.now() - ruleCache.loadedAt < RULE_CACHE_TTL_MS) return ruleCache.rules;
  const rules = await db.select().from(receiptWaiverRules).where(eq(receiptWaiverRules.enabled, true));
  ruleCache = { rules, loadedAt: Date.now() };
  return rules;
}

/**
 * Plaid upsert hook: the waiver rule for a new outflow, or null. Never throws — a broken rule
 * table must not block a bank sync (the transaction simply stays 'missing').
 */
export async function receiptWaiverForNewTransaction(input: {
  amountCents: number;
  merchant: string;
  businessId: string;
  categoryId: string | null;
}): Promise<WaiverMatch | null> {
  try {
    if (input.amountCents >= 0) return null;
    const rules = await activeWaiverRules();
    if (rules.length === 0) return null;
    let categoryName: string | null = null;
    let categoryTaxCode: string | null = null;
    if (input.categoryId && rules.some((rule) => rule.kind === 'threshold' && rule.excludeLodging)) {
      const category = await db.query.categories.findFirst({ where: eq(categories.id, input.categoryId) });
      categoryName = category?.name ?? null;
      categoryTaxCode = category?.taxCode ?? null;
    }
    return evaluateReceiptWaiver({ ...input, categoryName, categoryTaxCode }, rules);
  } catch (error) {
    console.warn('[receiptWaivers] rule evaluation failed; leaving receipt missing', error);
    return null;
  }
}

export async function listWaiverRules(): Promise<Array<ReceiptWaiverRule & { categoryName: string | null; waivedCount: number }>> {
  const rows = await db
    .select({ rule: receiptWaiverRules, categoryName: categories.name })
    .from(receiptWaiverRules)
    .leftJoin(categories, eq(receiptWaiverRules.categoryId, categories.id))
    .orderBy(sql`CASE ${receiptWaiverRules.kind} WHEN 'threshold' THEN 0 WHEN 'merchant' THEN 1 ELSE 2 END`, desc(receiptWaiverRules.createdAt));
  const counts = await db
    .select({ ruleId: transactionReceiptWaivers.ruleId, count: sql<number>`count(*)::int` })
    .from(transactionReceiptWaivers)
    .innerJoin(transactions, eq(transactions.id, transactionReceiptWaivers.transactionId))
    .where(eq(transactions.receiptStatus, 'waived'))
    .groupBy(transactionReceiptWaivers.ruleId);
  const countByRule = new Map(counts.map((row) => [row.ruleId, Number(row.count)]));
  return rows.map((row) => ({ ...row.rule, categoryName: row.categoryName ?? null, waivedCount: countByRule.get(row.rule.id) ?? 0 }));
}

export async function upsertThresholdRule(input: {
  enabled: boolean;
  thresholdCents: number;
  excludeLodging: boolean;
  userId?: string;
}): Promise<ReceiptWaiverRule> {
  const existing = await db.query.receiptWaiverRules.findFirst({ where: eq(receiptWaiverRules.kind, 'threshold') });
  const values = {
    enabled: input.enabled,
    thresholdCents: input.thresholdCents,
    excludeLodging: input.excludeLodging,
    updatedAt: new Date(),
  };
  const [rule] = existing
    ? await db.update(receiptWaiverRules).set(values).where(eq(receiptWaiverRules.id, existing.id)).returning()
    : await db.insert(receiptWaiverRules).values({ kind: 'threshold', ...values, createdByUserId: input.userId }).returning();
  invalidateWaiverRuleCache();
  return rule;
}

export class WaiverRuleInputError extends Error {}

export async function createMerchantRule(input: {
  merchant: string;
  businessId?: string | null;
  note?: string | null;
  userId?: string;
}): Promise<{ rule: ReceiptWaiverRule; created: boolean }> {
  const pattern = normalizeWaiverMerchant(input.merchant);
  if (pattern.length < MIN_MERCHANT_PATTERN_LENGTH) {
    throw new WaiverRuleInputError('Merchant name is too short or generic to make a rule from');
  }
  const businessId = input.businessId ?? null;
  const existing = await db.query.receiptWaiverRules.findFirst({
    where: and(
      eq(receiptWaiverRules.kind, 'merchant'),
      eq(receiptWaiverRules.merchantPattern, pattern),
      businessId ? eq(receiptWaiverRules.businessId, businessId) : isNull(receiptWaiverRules.businessId),
    ),
  });
  if (existing) {
    if (!existing.enabled) {
      const [enabled] = await db.update(receiptWaiverRules)
        .set({ enabled: true, updatedAt: new Date() })
        .where(eq(receiptWaiverRules.id, existing.id))
        .returning();
      invalidateWaiverRuleCache();
      return { rule: enabled, created: false };
    }
    return { rule: existing, created: false };
  }
  const [rule] = await db.insert(receiptWaiverRules).values({
    kind: 'merchant',
    businessId,
    merchantPattern: pattern,
    merchantLabel: input.merchant.trim().slice(0, 120),
    note: input.note ?? null,
    createdByUserId: input.userId,
  }).returning();
  invalidateWaiverRuleCache();
  return { rule, created: true };
}

export async function createCategoryRule(input: {
  categoryId: string;
  note?: string | null;
  userId?: string;
}): Promise<{ rule: ReceiptWaiverRule; created: boolean }> {
  const category = await db.query.categories.findFirst({ where: eq(categories.id, input.categoryId) });
  if (!category) throw new WaiverRuleInputError('Category not found');
  const existing = await db.query.receiptWaiverRules.findFirst({
    where: and(eq(receiptWaiverRules.kind, 'category'), eq(receiptWaiverRules.categoryId, input.categoryId)),
  });
  if (existing) return { rule: existing, created: false };
  const [rule] = await db.insert(receiptWaiverRules).values({
    kind: 'category',
    businessId: category.businessId,
    categoryId: input.categoryId,
    note: input.note ?? null,
    createdByUserId: input.userId,
  }).returning();
  invalidateWaiverRuleCache();
  return { rule, created: true };
}

export async function updateWaiverRule(id: string, patch: { enabled?: boolean; note?: string | null }): Promise<ReceiptWaiverRule | null> {
  const [rule] = await db.update(receiptWaiverRules)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(receiptWaiverRules.id, id))
    .returning();
  invalidateWaiverRuleCache();
  return rule ?? null;
}

/** Transactions a rule currently keeps waived (the ones deleting it with `reopen` would re-open). */
export async function waivedTransactionIdsForRule(ruleId: string): Promise<string[]> {
  const rows = await db
    .select({ id: transactions.id })
    .from(transactionReceiptWaivers)
    .innerJoin(transactions, eq(transactions.id, transactionReceiptWaivers.transactionId))
    .where(and(
      eq(transactionReceiptWaivers.ruleId, ruleId),
      eq(transactions.receiptStatus, 'waived'),
      isNull(transactions.receiptId),
    ));
  return rows.map((row) => row.id);
}

/**
 * Delete a rule. The global threshold rule can't be deleted (disable it instead). With `reopen`,
 * every transaction the rule waived goes back to 'missing'; otherwise they stay waived and keep
 * their evidence row (rule id nulled by the FK).
 */
export async function deleteWaiverRule(id: string, options: { reopen: boolean }): Promise<{ deleted: boolean; reopened: number } | null> {
  const rule = await db.query.receiptWaiverRules.findFirst({ where: eq(receiptWaiverRules.id, id) });
  if (!rule) return null;
  if (rule.kind === 'threshold') throw new WaiverRuleInputError('The global threshold rule can be disabled but not deleted');
  const reopened = await db.transaction(async (tx) => {
    let count = 0;
    if (options.reopen) {
      const ids = await waivedTransactionIdsForRule(id);
      if (ids.length > 0) {
        await tx.update(transactions)
          .set({ receiptStatus: 'missing', updatedAt: new Date() })
          .where(and(inArray(transactions.id, ids), eq(transactions.receiptStatus, 'waived')));
        await tx.delete(transactionReceiptWaivers).where(inArray(transactionReceiptWaivers.transactionId, ids));
        count = ids.length;
      }
    }
    await tx.delete(receiptWaiverRules).where(eq(receiptWaiverRules.id, id));
    return count;
  });
  invalidateWaiverRuleCache();
  return { deleted: true, reopened };
}

interface OpenMissingRow {
  transaction: Transaction;
  categoryName: string | null;
  categoryTaxCode: string | null;
}

/** Operating outflow still missing a receipt — the same set the close queue / Inbox count. */
async function openMissingTransactions(filter?: { merchantPattern?: string; ids?: string[] }): Promise<OpenMissingRow[]> {
  const rows = await db
    .select({ transaction: transactions, categoryName: categories.name, categoryTaxCode: categories.taxCode })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(and(
      eq(transactions.receiptStatus, 'missing'),
      isNull(transactions.receiptId),
      sql`${transactions.amountCents} < 0`,
      categoryIsVisibleSpend(),
      accountSpendFilter([]),
      filter?.ids ? inArray(transactions.id, filter.ids) : sql`true`,
    ));
  return rows.map((row) => ({ transaction: row.transaction, categoryName: row.categoryName, categoryTaxCode: row.categoryTaxCode }));
}

export interface WaiverApplyPreview {
  count: number;
  totalCents: number;
  byRule: Array<{ ruleId: string; kind: ReceiptWaiverRuleKind; label: string; count: number; totalCents: number }>;
  sampleTransactionIds: string[];
}

async function planApply(onlyRuleId?: string): Promise<{ preview: WaiverApplyPreview; hits: Array<{ transactionId: string; match: WaiverMatch }> }> {
  const rules = (await db.select().from(receiptWaiverRules).where(eq(receiptWaiverRules.enabled, true)))
    .filter((rule) => !onlyRuleId || rule.id === onlyRuleId);
  const hits: Array<{ transactionId: string; match: WaiverMatch; amountCents: number }> = [];
  if (rules.length > 0) {
    for (const row of await openMissingTransactions()) {
      const match = evaluateReceiptWaiver({
        amountCents: row.transaction.amountCents,
        merchant: row.transaction.merchant,
        businessId: row.transaction.businessId,
        categoryId: row.transaction.categoryId,
        categoryName: row.categoryName,
        categoryTaxCode: row.categoryTaxCode,
      }, rules);
      if (match) hits.push({ transactionId: row.transaction.id, match, amountCents: row.transaction.amountCents });
    }
  }
  const byRule = new Map<string, WaiverApplyPreview['byRule'][number]>();
  for (const hit of hits) {
    const entry = byRule.get(hit.match.ruleId) ?? { ruleId: hit.match.ruleId, kind: hit.match.kind, label: hit.match.label, count: 0, totalCents: 0 };
    entry.count += 1;
    entry.totalCents += Math.abs(hit.amountCents);
    byRule.set(hit.match.ruleId, entry);
  }
  return {
    preview: {
      count: hits.length,
      totalCents: hits.reduce((sum, hit) => sum + Math.abs(hit.amountCents), 0),
      byRule: [...byRule.values()],
      sampleTransactionIds: hits.slice(0, 10).map((hit) => hit.transactionId),
    },
    hits,
  };
}

export async function previewApplyWaivers(ruleId?: string): Promise<WaiverApplyPreview> {
  return (await planApply(ruleId)).preview;
}

/** Waive every open missing-receipt outflow an enabled rule covers. Idempotent. */
export async function applyWaiversToMissing(options: { ruleId?: string; userId?: string } = {}): Promise<{ waived: number }> {
  const { hits } = await planApply(options.ruleId);
  let waived = 0;
  for (let index = 0; index < hits.length; index += 500) {
    const batch = hits.slice(index, index + 500);
    waived += await db.transaction(async (tx) => {
      const updated = await tx.update(transactions)
        .set({ receiptStatus: 'waived', updatedAt: new Date() })
        .where(and(
          inArray(transactions.id, batch.map((hit) => hit.transactionId)),
          eq(transactions.receiptStatus, 'missing'),
          isNull(transactions.receiptId),
        ))
        .returning({ id: transactions.id });
      const updatedIds = new Set(updated.map((row) => row.id));
      const evidence = batch.filter((hit) => updatedIds.has(hit.transactionId));
      if (evidence.length > 0) {
        await tx.insert(transactionReceiptWaivers).values(evidence.map((hit) => ({
          transactionId: hit.transactionId,
          ruleId: hit.match.ruleId,
          kind: hit.match.kind as ReceiptWaiverEvidenceKind,
          detail: { label: hit.match.label, appliedBy: 'apply_to_existing' },
          createdByUserId: options.userId,
        }))).onConflictDoNothing();
      }
      return updated.length;
    });
  }
  return { waived };
}

/**
 * Record evidence for transactions the Plaid upsert path waived (it can't — the row id doesn't
 * exist yet when the status is decided). Looks at recently touched waived outflows with no
 * evidence row and re-evaluates the rules; anything no rule explains (e.g. spend before the
 * receipt-tracking cutoff) is left alone.
 */
export async function backfillWaiverEvidence(options: { sinceHours?: number; limit?: number } = {}): Promise<number> {
  const since = new Date(Date.now() - (options.sinceHours ?? 48) * 3_600_000);
  const rules = await db.select().from(receiptWaiverRules).where(eq(receiptWaiverRules.enabled, true));
  if (rules.length === 0) return 0;
  const rows = await db
    .select({ transaction: transactions, categoryName: categories.name, categoryTaxCode: categories.taxCode })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(transactionReceiptWaivers, eq(transactionReceiptWaivers.transactionId, transactions.id))
    .where(and(
      eq(transactions.receiptStatus, 'waived'),
      isNull(transactionReceiptWaivers.transactionId),
      gte(transactions.updatedAt, since),
      lt(transactions.amountCents, 0),
    ))
    .limit(options.limit ?? 2000);
  const values = rows.flatMap((row) => {
    const match = evaluateReceiptWaiver({
      amountCents: row.transaction.amountCents,
      merchant: row.transaction.merchant,
      businessId: row.transaction.businessId,
      categoryId: row.transaction.categoryId,
      categoryName: row.categoryName,
      categoryTaxCode: row.categoryTaxCode,
    }, rules);
    return match
      ? [{ transactionId: row.transaction.id, ruleId: match.ruleId, kind: match.kind as ReceiptWaiverEvidenceKind, detail: { label: match.label, appliedBy: 'bank_sync' } }]
      : [];
  });
  if (values.length > 0) await db.insert(transactionReceiptWaivers).values(values).onConflictDoNothing();
  return values.length;
}

export class WaiveTransactionError extends Error {}

/**
 * The user says this transaction needs no receipt. Optionally creates a merchant rule
 * ("always for this merchant") and applies it to the merchant's other open missing outflows.
 */
export async function waiveTransaction(input: {
  transactionId: string;
  userId?: string;
  alwaysForMerchant?: boolean;
  thisBusinessOnly?: boolean;
  note?: string | null;
}): Promise<{ transaction: Transaction; rule: ReceiptWaiverRule | null; alsoWaived: number } | null> {
  const transaction = await db.query.transactions.findFirst({ where: eq(transactions.id, input.transactionId) });
  if (!transaction) return null;
  if (transaction.receiptId || transaction.receiptStatus === 'matched') {
    throw new WaiveTransactionError('This transaction already has a receipt — unpair it first');
  }

  let rule: ReceiptWaiverRule | null = null;
  if (input.alwaysForMerchant) {
    rule = (await createMerchantRule({
      merchant: transaction.merchant,
      businessId: input.thisBusinessOnly ? transaction.businessId : null,
      note: input.note,
      userId: input.userId,
    })).rule;
  }

  const [updated] = await db.transaction(async (tx) => {
    const rows = await tx.update(transactions)
      .set({ receiptStatus: 'waived', updatedAt: new Date() })
      .where(eq(transactions.id, transaction.id))
      .returning();
    await tx.insert(transactionReceiptWaivers).values({
      transactionId: transaction.id,
      ruleId: rule?.id ?? null,
      kind: rule ? 'merchant' : 'manual',
      detail: { label: rule ? describeWaiverRule(rule) : 'Marked "no receipt needed"', note: input.note ?? null, appliedBy: 'user' },
      createdByUserId: input.userId,
    }).onConflictDoUpdate({
      target: transactionReceiptWaivers.transactionId,
      set: {
        ruleId: rule?.id ?? null,
        kind: rule ? 'merchant' : 'manual',
        detail: { label: rule ? describeWaiverRule(rule) : 'Marked "no receipt needed"', note: input.note ?? null, appliedBy: 'user' },
        createdByUserId: input.userId,
        createdAt: new Date(),
      },
    });
    return rows;
  });

  const alsoWaived = rule ? (await applyWaiversToMissing({ ruleId: rule.id, userId: input.userId })).waived : 0;
  return { transaction: updated ?? transaction, rule, alsoWaived };
}

/** Undo a waiver: back to 'missing' (only while still waived and receipt-less). */
export async function unwaiveTransaction(transactionId: string): Promise<Transaction | null> {
  return db.transaction(async (tx) => {
    const [updated] = await tx.update(transactions)
      .set({ receiptStatus: 'missing', updatedAt: new Date() })
      .where(and(eq(transactions.id, transactionId), eq(transactions.receiptStatus, 'waived'), isNull(transactions.receiptId)))
      .returning();
    if (!updated) return null;
    await tx.delete(transactionReceiptWaivers).where(eq(transactionReceiptWaivers.transactionId, transactionId));
    return updated;
  });
}

export interface WaiverEvidence {
  kind: ReceiptWaiverEvidenceKind | 'tracking_cutoff' | 'unknown';
  ruleId: string | null;
  label: string;
  note: string | null;
  createdAt: string | null;
}

/** Why a transaction is waived (null when it isn't). */
export async function waiverEvidenceFor(transactionId: string, receiptTrackingSince: string | null): Promise<WaiverEvidence | null> {
  const transaction = await db.query.transactions.findFirst({ where: eq(transactions.id, transactionId) });
  if (!transaction || transaction.receiptStatus !== 'waived') return null;
  const row = await db.query.transactionReceiptWaivers.findFirst({
    where: eq(transactionReceiptWaivers.transactionId, transactionId),
  });
  if (row) {
    return {
      kind: row.kind,
      ruleId: row.ruleId,
      label: typeof row.detail.label === 'string' ? row.detail.label : 'No receipt needed',
      note: typeof row.detail.note === 'string' ? row.detail.note : null,
      createdAt: row.createdAt.toISOString(),
    };
  }
  if (receiptTrackingSince && transaction.date < receiptTrackingSince) {
    return { kind: 'tracking_cutoff', ruleId: null, label: `Before receipt tracking began (${receiptTrackingSince})`, note: null, createdAt: null };
  }
  return { kind: 'unknown', ruleId: null, label: 'No receipt needed', note: null, createdAt: null };
}
