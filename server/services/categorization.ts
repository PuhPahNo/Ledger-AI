import OpenAI from 'openai';
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';
import { getEnv } from '../config/env.js';
import { db } from '../db/client.js';
import { categories, categoryRules, transactions } from '../db/schema.js';

export interface CategorizeInput {
  businessId: string;
  merchant: string;
  amountCents: number;
  plaidCategory?: string[];
}

const categorySuggestionSchema = z.object({
  categoryId: z.string().uuid().nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string().nullable(),
});

export async function categorizeTransaction(input: CategorizeInput): Promise<string | null> {
  const [rules, availableCategories] = await Promise.all([
    db
      .select({
        id: categoryRules.id,
        categoryId: categoryRules.categoryId,
        matchKind: categoryRules.matchKind,
        pattern: categoryRules.pattern,
        priority: categoryRules.priority,
      })
      .from(categoryRules)
      .where(or(eq(categoryRules.businessId, input.businessId), isNull(categoryRules.businessId)))
      .orderBy(asc(categoryRules.priority)),
    db
      .select({
        id: categories.id,
        businessId: categories.businessId,
        name: categories.name,
        taxCode: categories.taxCode,
      })
      .from(categories)
      .where(and(
        eq(categories.active, true),
        or(eq(categories.businessId, input.businessId), isNull(categories.businessId)),
      ))
      .orderBy(asc(categories.name)),
  ]);

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

  const aiSuggestion = await suggestCategoryWithAi(input, availableCategories);
  if (aiSuggestion) return aiSuggestion;

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

export async function learnMerchantCategoryRule(input: {
  businessId: string;
  merchant: string;
  categoryId: string;
}): Promise<void> {
  const pattern = normalize(input.merchant);
  if (!pattern || pattern === 'unknown merchant') return;

  const existing = await db.query.categoryRules.findFirst({
    where: and(
      eq(categoryRules.businessId, input.businessId),
      eq(categoryRules.matchKind, 'merchant_exact'),
      eq(categoryRules.pattern, pattern),
    ),
  });

  if (existing) {
    await db
      .update(categoryRules)
      .set({
        categoryId: input.categoryId,
        priority: 1,
        createdByAi: false,
        updatedAt: new Date(),
      })
      .where(eq(categoryRules.id, existing.id));
    return;
  }

  await db.insert(categoryRules).values({
    businessId: input.businessId,
    categoryId: input.categoryId,
    matchKind: 'merchant_exact',
    pattern,
    priority: 1,
    createdByAi: false,
  });
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function suggestCategoryWithAi(
  input: CategorizeInput,
  availableCategories: Array<{ id: string; name: string; taxCode: string | null; businessId: string | null }>,
): Promise<string | null> {
  const env = getEnv();
  if (!env.OPENAI_API_KEY || availableCategories.length === 0) return null;
  try {
    const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    const response = await client.responses.parse({
      model: env.OPENAI_CATEGORIZATION_MODEL,
      input: [{
        role: 'user',
        content: [{
          type: 'input_text',
          text: [
            'You are categorizing a business transaction for Ledger AI.',
            'Choose exactly one categoryId from the provided category list, or null if none fit.',
            'Prefer tax-oriented Schedule C categories over miscellaneous internal categories.',
            'Do not create new categories or tax codes.',
            `Transaction: ${JSON.stringify({
              merchant: input.merchant,
              amountCents: input.amountCents,
              plaidCategory: input.plaidCategory ?? [],
            })}`,
            `Categories: ${JSON.stringify(availableCategories)}`,
          ].join('\n'),
        }],
      }],
      text: {
        format: zodTextFormat(categorySuggestionSchema, 'category_suggestion'),
      },
    });

    const message = response.output.find((item) => item.type === 'message');
    const parsed = message?.content.find((item) => item.type === 'output_text')?.parsed;
    const suggestion = categorySuggestionSchema.parse(parsed);
    const categoryExists = availableCategories.some((category) => category.id === suggestion.categoryId);
    if (!categoryExists || suggestion.confidence < 0.6) return null;
    return suggestion.categoryId;
  } catch {
    return null;
  }
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
