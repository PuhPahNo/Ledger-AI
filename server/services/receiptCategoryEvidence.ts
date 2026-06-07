import OpenAI from 'openai';
import { and, asc, desc, eq, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';
import { getEnv } from '../config/env.js';
import { db } from '../db/client.js';
import {
  categories,
  receiptMatches,
  type Category,
  type CategorySource,
  type Receipt,
  type Transaction,
} from '../db/schema.js';
import {
  categoryMatchesTransactionDirection,
  categoryNameForKnownSignals,
  normalize,
} from './categorization.js';

const receiptAutoMatchThreshold = 0.82;
const receiptExtractionThreshold = 0.85;
const receiptCategoryThreshold = 0.8;

const receiptCategorySchema = z.object({
  categoryId: z.string().uuid().nullable(),
  confidence: z.number().min(0).max(1),
  evidence: z.string().nullable(),
});

export async function inferReceiptCategory(receipt: Receipt, transaction: Transaction): Promise<{
  categoryId: string | null;
  confidence: number;
  evidence: Record<string, unknown>;
}> {
  const availableCategories = await db
    .select()
    .from(categories)
    .where(and(
      eq(categories.active, true),
      or(eq(categories.businessId, transaction.businessId), isNull(categories.businessId)),
    ))
    .orderBy(asc(categories.name));
  const eligible = availableCategories.filter((category) => (
    categoryMatchesTransactionDirection(category, transaction.amountCents)
  ));
  const evidenceText = receiptEvidenceText(receipt, transaction);
  const hintedName = categoryNameFromReceiptJson(receipt.ocrJson);
  const hintedCategory = hintedName ? findPreferredCategoryByName(eligible, hintedName, transaction.businessId) : null;
  if (hintedCategory) {
    return {
      categoryId: hintedCategory.id,
      confidence: receiptCategoryConfidence(receipt.ocrJson, 0.84),
      evidence: { source: 'receipt_category_hint', hintedName, evidenceText },
    };
  }

  const signalName = categoryNameForKnownSignals({
    businessId: transaction.businessId,
    merchant: `${receipt.merchant ?? ''} ${transaction.merchant}`,
    amountCents: transaction.amountCents,
    plaidCategory: [evidenceText],
  });
  const signalCategory = signalName ? findPreferredCategoryByName(eligible, signalName, transaction.businessId) : null;
  if (signalCategory) {
    return {
      categoryId: signalCategory.id,
      confidence: 0.82,
      evidence: { source: 'receipt_signal_mapping', signalName, evidenceText },
    };
  }

  const aiSuggestion = await inferReceiptCategoryWithAi(receipt, transaction, eligible, evidenceText);
  return aiSuggestion ?? { categoryId: null, confidence: 0, evidence: { reason: 'no_receipt_category_match' } };
}

export function receiptEvidenceCanAutoApply(input: {
  matchScore?: number | null;
  receiptConfidence: number;
  categoryConfidence: number;
  categorySource: CategorySource;
}): boolean {
  return (input.matchScore ?? 0) >= receiptAutoMatchThreshold
    && input.receiptConfidence >= receiptExtractionThreshold
    && input.categoryConfidence >= receiptCategoryThreshold
    && canAutoOverwriteCategorySource(input.categorySource);
}

export function canAutoOverwriteCategorySource(source: CategorySource): boolean {
  return source === 'auto_rule'
    || source === 'plaid_signal'
    || source === 'ai_suggested'
    || source === 'uncategorized';
}

export async function latestReceiptMatchScore(receiptId: string, transactionId: string): Promise<number | null> {
  const [match] = await db
    .select({ score: receiptMatches.score })
    .from(receiptMatches)
    .where(and(eq(receiptMatches.receiptId, receiptId), eq(receiptMatches.transactionId, transactionId)))
    .orderBy(desc(receiptMatches.createdAt))
    .limit(1);
  return parseConfidence(match?.score);
}

export function parseConfidence(value: unknown): number {
  if (value == null) return 0;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function plaidCategoryHints(raw: Record<string, unknown>): string[] {
  const personalFinanceCategory = (
    raw.personal_finance_category && typeof raw.personal_finance_category === 'object'
      ? raw.personal_finance_category
      : {}
  ) as Record<string, unknown>;
  return [
    ...(Array.isArray(raw.category) ? raw.category : []),
    personalFinanceCategory.primary,
    personalFinanceCategory.detailed,
    personalFinanceCategory.confidence_level,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
}

async function inferReceiptCategoryWithAi(
  receipt: Receipt,
  transaction: Transaction,
  availableCategories: Category[],
  evidenceText: string,
): Promise<{ categoryId: string | null; confidence: number; evidence: Record<string, unknown> } | null> {
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
            'Use receipt evidence to choose the best Ledger AI business expense category.',
            'Choose exactly one categoryId from the provided list, or null if the receipt evidence is not enough.',
            'Do not choose an income category for an outflow.',
            `Transaction: ${JSON.stringify({
              merchant: transaction.merchant,
              amountCents: transaction.amountCents,
              plaidCategory: plaidCategoryHints(transaction.raw),
            })}`,
            `Receipt: ${JSON.stringify({
              merchant: receipt.merchant,
              totalCents: receipt.totalCents,
              receiptDate: receipt.receiptDate,
              ocrJson: receipt.ocrJson,
              evidenceText,
            })}`,
            `Categories: ${JSON.stringify(availableCategories.map((category) => ({
              id: category.id,
              name: category.name,
              taxCode: category.taxCode,
            })))}`,
          ].join('\n'),
        }],
      }],
      text: {
        format: zodTextFormat(receiptCategorySchema, 'receipt_category'),
      },
    });
    const message = response.output.find((item) => item.type === 'message');
    const parsed = message?.content.find((item) => item.type === 'output_text')?.parsed;
    const suggestion = receiptCategorySchema.parse(parsed);
    const exists = availableCategories.some((category) => category.id === suggestion.categoryId);
    if (!exists) return null;
    return {
      categoryId: suggestion.categoryId,
      confidence: suggestion.confidence,
      evidence: { source: 'receipt_ai', reason: suggestion.evidence, evidenceText },
    };
  } catch {
    return null;
  }
}

function receiptCategoryConfidence(ocrJson: Record<string, unknown>, fallback: number): number {
  const value = ocrJson.categoryConfidence ?? ocrJson.category_confidence;
  const confidence = parseConfidence(value);
  return confidence > 0 ? confidence : fallback;
}

function categoryNameFromReceiptJson(ocrJson: Record<string, unknown>): string | null {
  const value = ocrJson.categoryHint ?? ocrJson.category_hint ?? ocrJson.categoryName ?? ocrJson.category_name;
  return typeof value === 'string' && value.trim() ? value : null;
}

function receiptEvidenceText(receipt: Receipt, transaction: Transaction): string {
  const ocrJson = receipt.ocrJson ?? {};
  return [
    receipt.merchant,
    transaction.merchant,
    ocrJson.categoryHint,
    ocrJson.categoryEvidence,
    ocrJson.notes,
    JSON.stringify(ocrJson.lineItems ?? ocrJson.line_items ?? []),
    JSON.stringify(plaidCategoryHints(transaction.raw)),
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ');
}

function findPreferredCategoryByName(
  categoryRows: Category[],
  name: string,
  businessId: string,
): Category | null {
  const normalizedName = normalize(name);
  const matches = categoryRows.filter((category) => normalize(category.name) === normalizedName);
  return matches.find((category) => category.businessId === businessId)
    ?? matches.find((category) => category.businessId === null)
    ?? matches[0]
    ?? null;
}
