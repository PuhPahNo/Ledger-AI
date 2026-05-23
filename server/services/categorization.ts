import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { categories, categoryRules, transactions } from '../db/schema.js';

export interface CategorizeInput {
  businessId: string;
  merchant: string;
  amountCents: number;
  plaidCategory?: string[];
}

export async function categorizeTransaction(input: CategorizeInput): Promise<string | null> {
  const rules = await db
    .select({
      id: categoryRules.id,
      categoryId: categoryRules.categoryId,
      matchKind: categoryRules.matchKind,
      pattern: categoryRules.pattern,
      priority: categoryRules.priority,
    })
    .from(categoryRules)
    .where(or(eq(categoryRules.businessId, input.businessId), isNull(categoryRules.businessId)))
    .orderBy(asc(categoryRules.priority));

  const merchant = normalize(input.merchant);
  const plaidCategory = normalize(input.plaidCategory?.join(' ') ?? '');

  for (const rule of rules) {
    if (ruleMatches({
      matchKind: rule.matchKind,
      pattern: rule.pattern,
      merchant,
      plaidCategory,
      amountCents: input.amountCents,
    })) {
      return rule.categoryId;
    }
  }

  const uncategorized = await db.query.categories.findFirst({
    where: and(isNull(categories.businessId), eq(categories.name, 'Uncategorized')),
  });
  return uncategorized?.id ?? null;
}

export async function applyCategory(transactionId: string): Promise<void> {
  const txn = await db.query.transactions.findFirst({ where: eq(transactions.id, transactionId) });
  if (!txn) return;
  const categoryId = await categorizeTransaction({
    businessId: txn.businessId,
    merchant: txn.merchant,
    amountCents: txn.amountCents,
  });
  if (categoryId) {
    await db.update(transactions).set({ categoryId, updatedAt: new Date() }).where(eq(transactions.id, transactionId));
  }
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function ruleMatches(input: {
  matchKind: string;
  pattern: string;
  merchant: string;
  plaidCategory?: string;
  amountCents: number;
}): boolean {
  const merchant = normalize(input.merchant);
  const pattern = normalize(input.pattern);
  const plaidCategory = normalize(input.plaidCategory ?? '');
  if (input.matchKind === 'merchant_contains') return merchant.includes(pattern);
  if (input.matchKind === 'merchant_exact') return merchant === pattern;
  if (input.matchKind === 'plaid_category') return plaidCategory.includes(pattern);
  if (input.matchKind === 'amount_range') return matchesAmountRange(input.amountCents, input.pattern);
  return false;
}

function matchesAmountRange(amountCents: number, pattern: string): boolean {
  const [rawMin, rawMax] = pattern.split('..');
  const min = rawMin ? Number(rawMin) : Number.NEGATIVE_INFINITY;
  const max = rawMax ? Number(rawMax) : Number.POSITIVE_INFINITY;
  const abs = Math.abs(amountCents);
  return abs >= min && abs <= max;
}
