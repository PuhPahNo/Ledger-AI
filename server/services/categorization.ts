import OpenAI from 'openai';
import { and, asc, desc, eq, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';
import { getEnv } from '../config/env.js';
import { db } from '../db/client.js';
import {
  categories,
  categoryRules,
  categorizationFeedback,
  transactions,
  type CategorySource,
} from '../db/schema.js';

export interface CategorizeInput {
  businessId: string;
  merchant: string;
  amountCents: number;
  plaidCategory?: string[];
}

export interface CategorizeResult {
  categoryId: string | null;
  source: CategorySource;
  confidence: number | null;
  evidence: Record<string, unknown>;
}

interface CategoryCandidate {
  id: string;
  businessId: string | null;
  name: string;
  taxCode: string | null;
}

const categorySuggestionSchema = z.object({
  categoryId: z.string().uuid().nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string().nullable(),
});

export async function categorizeTransaction(input: CategorizeInput): Promise<string | null> {
  const result = await categorizeTransactionWithDetails(input);
  return result.categoryId;
}

export async function categorizeTransactionWithDetails(input: CategorizeInput): Promise<CategorizeResult> {
  const [rules, availableCategories] = await Promise.all([
    db
      .select({
        id: categoryRules.id,
        businessId: categoryRules.businessId,
        categoryId: categoryRules.categoryId,
        matchKind: categoryRules.matchKind,
        pattern: categoryRules.pattern,
        priority: categoryRules.priority,
        createdByAi: categoryRules.createdByAi,
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

  const incomeCategory = preferredIncomeCategory(availableCategories, input.businessId);
  if (input.amountCents > 0) {
    const categoryId = incomeCategory?.id ?? (await fallbackUncategorizedCategory());
    return {
      categoryId,
      source: categoryId === incomeCategory?.id ? 'auto_rule' : 'uncategorized',
      confidence: categoryId === incomeCategory?.id ? 1 : null,
      evidence: { reason: 'inflow_direction_guard' },
    };
  }

  const categoryById = new Map(availableCategories.map((category) => [category.id, category]));
  const merchant = normalize(input.merchant);
  const plaidCategory = normalize(input.plaidCategory?.join(' ') ?? '');

  for (const rule of rules) {
    const targetCategory = categoryById.get(rule.categoryId);
    if (!targetCategory || !categoryMatchesTransactionDirection(targetCategory, input.amountCents)) continue;
    if (ruleMatches({
      matchKind: rule.matchKind,
      pattern: rule.pattern,
      merchant,
      plaidCategory,
      amountCents: input.amountCents,
    })) {
      return {
        categoryId: rule.categoryId,
        source: rule.businessId === input.businessId && !rule.createdByAi && rule.priority <= 1
          ? 'user_confirmed_rule'
          : 'auto_rule',
        confidence: 1,
        evidence: {
          ruleId: rule.id,
          matchKind: rule.matchKind,
          pattern: rule.pattern,
        },
      };
    }
  }

  const signalCategoryName = categoryNameForKnownSignals(input);
  const signalCategory = signalCategoryName
    ? findPreferredCategoryByName(availableCategories, signalCategoryName, input.businessId)
    : null;
  if (signalCategory && categoryMatchesTransactionDirection(signalCategory, input.amountCents)) {
    return {
      categoryId: signalCategory.id,
      source: 'plaid_signal',
      confidence: 0.85,
      evidence: {
        categoryName: signalCategory.name,
        signals: [input.merchant, ...(input.plaidCategory ?? [])],
      },
    };
  }

  const aiEligibleCategories = availableCategories.filter((category) => (
    categoryMatchesTransactionDirection(category, input.amountCents)
  ));
  const aiSuggestion = await suggestCategoryWithAi(input, aiEligibleCategories);
  if (aiSuggestion) return aiSuggestion;

  return {
    categoryId: await fallbackUncategorizedCategory(),
    source: 'uncategorized',
    confidence: null,
    evidence: { reason: 'no_rule_or_ai_confident_match' },
  };
}

async function fallbackUncategorizedCategory(): Promise<string | null> {
  const uncategorized = await db.query.categories.findFirst({
    where: and(isNull(categories.businessId), eq(categories.name, 'Uncategorized')),
  });
  return uncategorized?.id ?? null;
}

export async function applyCategory(transactionId: string): Promise<void> {
  const txn = await db.query.transactions.findFirst({ where: eq(transactions.id, transactionId) });
  if (!txn) return;
  const result = await categorizeTransactionWithDetails({
    businessId: txn.businessId,
    merchant: txn.merchant,
    amountCents: txn.amountCents,
  });
  if (result.categoryId) {
    await db
      .update(transactions)
      .set({
        categoryId: result.categoryId,
        categorySource: result.source,
        categoryConfidence: result.confidence == null ? null : result.confidence.toFixed(4),
        categoryEvidence: result.evidence,
        updatedAt: new Date(),
      })
      .where(eq(transactions.id, transactionId));
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

export function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function isIncomeCategory(category: CategoryCandidate): boolean {
  const name = normalize(category.name);
  return category.taxCode === 'income' || name === 'income' || name === 'revenue';
}

export function categoryMatchesTransactionDirection(category: CategoryCandidate, amountCents: number): boolean {
  if (amountCents < 0) return !isIncomeCategory(category);
  if (amountCents > 0) return isIncomeCategory(category);
  return true;
}

export function preferredIncomeCategory(categories: CategoryCandidate[], businessId: string): CategoryCandidate | null {
  const incomeCategories = categories.filter(isIncomeCategory);
  return incomeCategories.find((category) => category.businessId === businessId)
    ?? incomeCategories.find((category) => category.businessId === null)
    ?? incomeCategories[0]
    ?? null;
}

export function isExcludedFromSpendCategory(category: Pick<CategoryCandidate, 'name' | 'taxCode'>): boolean {
  return Boolean(category.taxCode?.startsWith('exclude_')) || normalize(category.name) === 'transfers';
}

export function categoryNameForKnownSignals(input: CategorizeInput): string | null {
  if (input.amountCents >= 0) return null;
  const signal = normalize([
    input.merchant,
    ...(input.plaidCategory ?? []),
  ].join(' '));

  if (hasAny(signal, [
    'transfer out',
    'account transfer',
    'credit card payment',
    'loan payments credit card',
    'investment retirement funds',
    'savings transfer',
    'withdrawal transfer',
  ])) return 'Transfers';

  if (hasAny(signal, ['advertising', 'marketing', 'google ads', 'facebook ads', 'meta ads', 'linkedin ads', 'mailchimp', 'klaviyo'])) return 'Advertising & Marketing';
  if (hasAny(signal, ['aws', 'amazon web services', 'google cloud', 'gcp', 'azure', 'cloudflare', 'digital ocean', 'heroku', 'render', 'vercel', 'netlify', 'supabase'])) return 'Cloud';
  if (hasAny(signal, ['software', 'figma', 'notion', 'adobe', 'linear', 'github', 'slack', 'zoom', 'google workspace', 'microsoft', 'openai', 'anthropic', 'canva', 'airtable', 'quickbooks', 'xero'])) return 'Software';
  if (hasAny(signal, ['food and drink', 'restaurant', 'coffee', 'cafe', 'fast food', 'sweetgreen', 'starbucks', 'doordash', 'uber eats', 'grubhub'])) return 'Meals';
  if (hasAny(signal, ['airline', 'airport', 'hotel', 'lodging', 'travel', 'taxi', 'rideshare', 'uber trip', 'lyft', 'rental car', 'airbnb'])) return 'Travel';
  if (hasAny(signal, ['gas station', 'fuel', 'parking', 'toll', 'automotive', 'auto parts', 'vehicle', 'car wash'])) return 'Car & Truck';
  if (hasAny(signal, ['office supplies', 'printing', 'postage', 'shipping', 'usps', 'fedex', 'ups store'])) return 'Office Expense';
  if (hasAny(signal, ['wholesale', 'inventory', 'cost of goods', 'supplier', 'product', 'merchandise', 'costco business'])) return 'Inventory';
  if (hasAny(signal, ['electronics', 'hardware', 'equipment', 'computer equipment', 'apple store', 'best buy', 'square hardware'])) return 'Equipment';
  if (hasAny(signal, ['utilities', 'internet', 'telecom', 'mobile phone', 'comcast', 'verizon', 'at t', 't mobile', 'electric', 'water', 'natural gas'])) return 'Utilities';
  if (hasAny(signal, ['rent', 'lease', 'property management'])) return 'Rent Or Lease';
  if (hasAny(signal, ['insurance'])) return 'Insurance';
  if (hasAny(signal, ['tax payment', 'taxes', 'license', 'permit', 'irs', 'department of revenue', 'secretary of state'])) return 'Taxes & Licenses';
  if (hasAny(signal, ['payroll', 'wages', 'salary', 'gusto', 'adp', 'paychex'])) return 'Wages';
  if (hasAny(signal, ['contractor', 'freelance', 'upwork', 'fiverr'])) return 'Contract Labor';
  if (hasAny(signal, ['legal', 'attorney', 'lawyer', 'accounting', 'accountant', 'bookkeeping', 'professional services', 'consulting', 'tax prep'])) return 'Legal & Professional';
  if (hasAny(signal, ['repair', 'maintenance'])) return 'Repairs & Maintenance';
  if (hasAny(signal, ['interest charge', 'loan interest'])) return 'Interest';
  if (hasAny(signal, ['bank fee', 'atm fee', 'processing fee', 'service fee', 'merchant fee', 'commission', 'stripe fee', 'paypal fee', 'square fee'])) return 'Commissions & Fees';
  if (hasAny(signal, ['entertainment', 'amusement', 'event tickets', 'movies', 'sports venue'])) return 'Entertainment';
  if (hasAny(signal, ['general merchandise', 'amazon', 'target', 'walmart', 'office depot', 'staples'])) return 'Supplies';

  return null;
}

function findPreferredCategoryByName(categories: CategoryCandidate[], name: string, businessId: string): CategoryCandidate | null {
  const normalizedName = normalize(name);
  const matches = categories.filter((category) => normalize(category.name) === normalizedName);
  return matches.find((category) => category.businessId === businessId)
    ?? matches.find((category) => category.businessId === null)
    ?? matches[0]
    ?? null;
}

function hasAny(value: string, terms: string[]): boolean {
  return terms.some((term) => value.includes(normalize(term)));
}

async function suggestCategoryWithAi(
  input: CategorizeInput,
  availableCategories: CategoryCandidate[],
): Promise<CategorizeResult | null> {
  const env = getEnv();
  if (!env.OPENAI_API_KEY || availableCategories.length === 0) return null;
  try {
    const feedbackExamples = await loadFeedbackExamples(input);
    const direction = input.amountCents > 0 ? 'inflow/income' : input.amountCents < 0 ? 'outflow/expense' : 'zero amount';
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
            `Transaction direction: ${direction}. Never contradict the direction.`,
            'Prefer tax-oriented Schedule C categories over miscellaneous internal categories.',
            'Do not create new categories or tax codes.',
            `Transaction: ${JSON.stringify({
              merchant: input.merchant,
              amountCents: input.amountCents,
              plaidCategory: input.plaidCategory ?? [],
            })}`,
            `Accepted feedback examples: ${JSON.stringify(feedbackExamples)}`,
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
    return {
      categoryId: suggestion.categoryId,
      source: 'ai_suggested',
      confidence: suggestion.confidence,
      evidence: {
        reason: suggestion.reason,
        feedbackExamples,
      },
    };
  } catch {
    return null;
  }
}

async function loadFeedbackExamples(input: CategorizeInput): Promise<Array<{
  merchant: string;
  normalizedMerchant: string;
  categoryId: string;
  source: string;
}>> {
  const normalizedMerchant = normalize(input.merchant);
  const exact = await db
    .select({
      merchant: categorizationFeedback.merchant,
      normalizedMerchant: categorizationFeedback.normalizedMerchant,
      categoryId: categorizationFeedback.newCategoryId,
      source: categorizationFeedback.source,
    })
    .from(categorizationFeedback)
    .where(and(
      eq(categorizationFeedback.businessId, input.businessId),
      eq(categorizationFeedback.normalizedMerchant, normalizedMerchant),
    ))
    .orderBy(desc(categorizationFeedback.createdAt))
    .limit(5);
  if (exact.length) return exact;

  return db
    .select({
      merchant: categorizationFeedback.merchant,
      normalizedMerchant: categorizationFeedback.normalizedMerchant,
      categoryId: categorizationFeedback.newCategoryId,
      source: categorizationFeedback.source,
    })
    .from(categorizationFeedback)
    .where(eq(categorizationFeedback.businessId, input.businessId))
    .orderBy(desc(categorizationFeedback.createdAt))
    .limit(8);
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
