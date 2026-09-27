import OpenAI from 'openai';
import { and, asc, desc, eq, isNull, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';
import { getEnv } from '../config/env.js';
import { db } from '../db/client.js';
import {
  aiCategorizationCache,
  categories,
  categoryRules,
  categorizationFeedback,
  type CategorySource,
} from '../db/schema.js';
import { trackOpenAiCall } from './aiUsageTelemetry.js';
import { decrementDailyCounter, getDailyCounter, incrementDailyCounter } from './appSettings.js';

/**
 * Sources that represent explicit human judgment — never silently overwritten by rules,
 * Plaid updates, or receipt evidence. Keep in sync with the SQL CASE in plaid.ts upserts.
 */
export const PROTECTED_CATEGORY_SOURCES: ReadonlySet<string> = new Set([
  'manual',
  'user_confirmed_rule',
  'receipt_evidence',
]);

export function isProtectedCategorySource(source: string | null | undefined): boolean {
  return source != null && PROTECTED_CATEGORY_SOURCES.has(source);
}

/**
 * AI suggestions at or above this confidence are applied automatically (Plaid sync and
 * the nightly uncategorized scan alike); anything lower goes to the review center.
 */
export const AI_AUTO_APPLY_CONFIDENCE = 0.85;

export function shouldAutoApplyAiSuggestion(result: Pick<CategorizeResult, 'source' | 'confidence'>): boolean {
  return result.source === 'ai_suggested' && (result.confidence ?? 0) >= AI_AUTO_APPLY_CONFIDENCE;
}

export interface CategorizeInput {
  businessId: string;
  merchant: string;
  amountCents: number;
  plaidCategory?: string[];
  allowAi?: boolean;
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
  needsWebSearch: z.boolean(),
});
type CategorySuggestion = z.infer<typeof categorySuggestionSchema>;

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
        userConfirmed: categoryRules.userConfirmed,
        updatedAt: categoryRules.updatedAt,
      })
      .from(categoryRules)
      .where(or(eq(categoryRules.businessId, input.businessId), isNull(categoryRules.businessId)))
      .orderBy(asc(categoryRules.priority))
      .then((rows) => rows.sort(compareRulePrecedence)),
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
        source: ruleCategorySource(rule),
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

  if (input.allowAi !== false) {
    const aiEligibleCategories = availableCategories.filter((category) => (
      isAiEligibleCategory(category, input.amountCents)
    ));
    const aiSuggestion = await suggestCategoryWithAi(input, aiEligibleCategories);
    if (aiSuggestion) return aiSuggestion;
  }

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

/**
 * Payment-processor prefixes that bank descriptors prepend to the real merchant
 * ("SQ *BOBA GUYS", "TST* MCDONALDS", "PAYPAL *SPOTIFY"). Dropped during normalization
 * so rules learned from one descriptor style match the others.
 */
const PROCESSOR_PREFIXES = new Set(['sq', 'tst', 'py', 'pp', 'paypal', 'pos', 'ach', 'sp', 'gpay', 'aplpay', 'intuit']);

export function normalize(value: string): string {
  const base = value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  let tokens = base.split(' ').filter(Boolean);
  while (tokens.length > 1 && PROCESSOR_PREFIXES.has(tokens[0])) tokens = tokens.slice(1);
  // Store numbers and phone fragments vary per location ("STARBUCKS 800 4467"); drop
  // pure-digit runs of 3+ except in leading position ("76", "7 eleven" keep their digits).
  const cleaned = tokens.filter((token, index) => index === 0 || token.length < 3 || !/^\d+$/.test(token));
  return (cleaned.length > 0 ? cleaned : tokens).join(' ');
}

export function isIncomeCategory(category: CategoryCandidate): boolean {
  const name = normalize(category.name);
  return category.taxCode === 'income' || name === 'income' || name === 'revenue';
}

export function categoryMatchesTransactionDirection(category: CategoryCandidate, amountCents: number): boolean {
  if (isExcludedFromSpendCategory(category)) return true;
  if (amountCents < 0) return !isIncomeCategory(category);
  if (amountCents > 0) return isIncomeCategory(category);
  return true;
}

export function isAiEligibleCategory(category: CategoryCandidate, amountCents: number): boolean {
  return normalize(category.name) !== 'uncategorized'
    && categoryMatchesTransactionDirection(category, amountCents);
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
  const signal = normalize([
    input.merchant,
    ...(input.plaidCategory ?? []),
  ].join(' '));

  if (hasAny(signal, [
    'transfer in',
    'transfer out',
    'account transfer',
    'credit card payment',
    'loan payments credit card',
    'investment retirement funds',
    'savings transfer',
    'withdrawal transfer',
  ])) return 'Transfers';

  if (input.amountCents >= 0) return null;

  if (hasAny(signal, ['advertising', 'marketing', 'google ads', 'facebook ads', 'meta ads', 'linkedin ads', 'mailchimp', 'klaviyo'])) return 'Advertising & Marketing';
  if (hasAny(signal, ['aws', 'amazon web services', 'google cloud', 'gcp', 'azure', 'cloudflare', 'digital ocean', 'heroku', 'render', 'vercel', 'netlify', 'supabase'])) return 'Cloud';
  if (hasAny(signal, ['software', 'figma', 'notion', 'adobe', 'linear', 'github', 'slack', 'zoom', 'google workspace', 'microsoft', 'openai', 'anthropic', 'canva', 'airtable', 'quickbooks', 'xero'])) return 'Software';
  if (hasAny(signal, ['food and drink', 'restaurant', 'coffee', 'cafe', 'fast food', 'sweetgreen', 'starbucks', 'doordash', 'uber eats', 'grubhub'])) return 'Meals';
  if (hasAny(signal, ['airline', 'airport', 'hotel', 'lodging', 'travel', 'taxi', 'rideshare', 'uber trip', 'lyft', 'rental car', 'airbnb'])) return 'Travel';
  if (hasAny(signal, ['gas station', 'fuel', 'parking', 'toll', 'automotive', 'auto parts', 'vehicle', 'car wash'])) return 'Car & Truck';
  if (hasAny(signal, ['office supplies', 'printing', 'postage', 'shipping', 'usps', 'fedex', 'ups store'])) return 'Office Expense';
  if (hasAny(signal, ['wholesale', 'inventory', 'cost of goods', 'supplier', 'product', 'merchandise', 'costco business'])) return 'Inventory';
  if (hasAny(signal, ['electronics', 'hardware', 'equipment', 'computer equipment', 'apple store', 'best buy', 'square hardware'])) return 'Equipment';
  if (hasAny(signal, ['utilities', 'internet', 'telecom', 'mobile phone', 'comcast', 'verizon', 'at t', 't mobile', 'electric', 'electricity', 'gas and electricity', 'telecommunications', 'telephone', 'water', 'natural gas'])) return 'Utilities';
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

/**
 * Whole-word (token-sequence) match on normalized text, allowing a plural suffix on the
 * last word ("airline" matches "airlines") — plain substring matching let "render" hit
 * "surrender" and "rent" hit "parent"/"current".
 */
export function containsTerm(normalizedValue: string, term: string): boolean {
  const needle = normalize(term);
  if (!needle) return false;
  return new RegExp(`(?:^| )${needle}(?:s|es)?(?= |$)`).test(normalizedValue);
}

function hasAny(value: string, terms: string[]): boolean {
  return terms.some((term) => containsTerm(value, term));
}

const AI_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AI_WEB_FALLBACK_CONFIDENCE = 0.85;
const DAY_MS = 24 * 60 * 60 * 1000;
export const AI_USAGE_SETTING_KEY = 'ai_categorization_usage';
export const AI_WEB_SEARCH_USAGE_SETTING_KEY = 'ai_categorization_web_search_usage';

function aiCacheDirection(amountCents: number): string {
  return amountCents > 0 ? 'in' : 'out';
}

/** Today's AI call count, tracked atomically in app settings. */
export async function getAiUsage(): Promise<{ date: string; calls: number }> {
  return getDailyCounter(AI_USAGE_SETTING_KEY);
}

/** Today's expensive hosted-web subset of the categorization call count. */
export async function getAiWebSearchUsage(): Promise<{ date: string; calls: number }> {
  return getDailyCounter(AI_WEB_SEARCH_USAGE_SETTING_KEY);
}

/**
 * Reserve one categorization call against today's budget. Called immediately before the
 * request is sent so only calls actually made are counted; each increment is a single
 * atomic SQL statement so concurrent workers can't overspend.
 */
async function reserveAiCategorizationCall(webSearch: boolean): Promise<boolean> {
  const env = getEnv();
  if (!await incrementDailyCounter(AI_USAGE_SETTING_KEY, env.OPENAI_CATEGORIZATION_DAILY_LIMIT)) return false;
  if (!webSearch) return true;
  if (await incrementDailyCounter(AI_WEB_SEARCH_USAGE_SETTING_KEY, env.OPENAI_CATEGORIZATION_DAILY_WEB_SEARCH_LIMIT)) {
    return true;
  }
  // Web budget exhausted — the call won't be made, so hand back the total reservation.
  await decrementDailyCounter(AI_USAGE_SETTING_KEY);
  return false;
}

export function shouldUseCategorizationWebSearch(
  suggestion: Pick<CategorySuggestion, 'needsWebSearch'>,
  webSearchEnabled: boolean,
): boolean {
  return webSearchEnabled && suggestion.needsWebSearch;
}

export function categorizationWebToolOptions(useWebSearch: boolean) {
  return useWebSearch
    ? {
        tools: [{
          type: 'web_search_preview' as const,
          search_context_size: 'low' as const,
        }],
        tool_choice: { type: 'web_search_preview' as const },
        max_tool_calls: 1,
      }
    : {};
}

export function categorizationRetryDelayMs(failureCount: number): number {
  return failureCount <= 1 ? 7 * DAY_MS : 30 * DAY_MS;
}

async function suggestCategoryWithAi(
  input: CategorizeInput,
  availableCategories: CategoryCandidate[],
): Promise<CategorizeResult | null> {
  const env = getEnv();
  if (!env.OPENAI_API_KEY || availableCategories.length === 0) return null;

  // Same merchant, same direction, judged recently → reuse the verdict instead of
  // paying for another call (a null category verdict is a verdict too).
  const normalizedMerchant = normalize(input.merchant);
  const direction = aiCacheDirection(input.amountCents);
  const cached = await db.query.aiCategorizationCache.findFirst({
    where: and(
      eq(aiCategorizationCache.businessId, input.businessId),
      eq(aiCategorizationCache.normalizedMerchant, normalizedMerchant),
      eq(aiCategorizationCache.direction, direction),
    ),
  });
  const retryBlocked = cached
    && cached.outcome !== 'result'
    && cached.retryAfter
    && cached.retryAfter.getTime() > Date.now();
  if (retryBlocked) return null;

  if (cached?.outcome === 'result' && Date.now() - cached.updatedAt.getTime() < AI_CACHE_TTL_MS) {
    if (!cached.categoryId) return null;
    if (!availableCategories.some((category) => category.id === cached.categoryId)) return null;
    return {
      categoryId: cached.categoryId,
      source: 'ai_suggested',
      confidence: cached.confidence == null ? null : Number(cached.confidence),
      evidence: { reason: cached.reason, cachedAt: cached.updatedAt.toISOString() },
    };
  }

  let feedbackExamples: Awaited<ReturnType<typeof loadFeedbackExamples>>;
  try {
    feedbackExamples = await loadFeedbackExamples(input);
  } catch {
    return null;
  }

  if (!await reserveAiCategorizationCall(false)) return null;

  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  let baseSuggestion: CategorySuggestion;
  try {
    baseSuggestion = await requestCategorySuggestion(
      client,
      input,
      availableCategories,
      feedbackExamples,
      false,
    );
  } catch {
    await cacheAiCategorizationFailure({
      input,
      normalizedMerchant,
      direction,
      priorFailureCount: cached?.outcome === 'error' ? cached.failureCount : 0,
    });
    return null;
  }

  if (!baseSuggestion.needsWebSearch) {
    return saveAiCategorizationResult({
      input,
      normalizedMerchant,
      direction,
      suggestion: baseSuggestion,
      availableCategories,
      feedbackExamples,
      usedWebSearch: false,
      minimumConfidence: 0.6,
    });
  }

  const canSearch = shouldUseCategorizationWebSearch(
    baseSuggestion,
    env.OPENAI_CATEGORIZATION_WEB_SEARCH,
  ) && await reserveAiCategorizationCall(true);
  if (canSearch) {
    try {
      const webSuggestion = await requestCategorySuggestion(
        client,
        input,
        availableCategories,
        feedbackExamples,
        true,
      );
      return saveAiCategorizationResult({
        input,
        normalizedMerchant,
        direction,
        suggestion: webSuggestion,
        availableCategories,
        feedbackExamples,
        usedWebSearch: true,
        minimumConfidence: 0.6,
      });
    } catch {
      if (!acceptedCategoryId(baseSuggestion, availableCategories, AI_WEB_FALLBACK_CONFIDENCE)) {
        await cacheAiCategorizationFailure({
          input,
          normalizedMerchant,
          direction,
          priorFailureCount: cached?.outcome === 'error' ? cached.failureCount : 0,
        });
        return null;
      }
    }
  }

  if (acceptedCategoryId(baseSuggestion, availableCategories, AI_WEB_FALLBACK_CONFIDENCE)) {
    return saveAiCategorizationResult({
      input,
      normalizedMerchant,
      direction,
      suggestion: baseSuggestion,
      availableCategories,
      feedbackExamples,
      usedWebSearch: false,
      minimumConfidence: AI_WEB_FALLBACK_CONFIDENCE,
    });
  }

  if (env.OPENAI_CATEGORIZATION_WEB_SEARCH) {
    await cacheAiCategorizationDeferred(input, normalizedMerchant, direction);
  } else {
    await saveAiCategorizationResult({
      input,
      normalizedMerchant,
      direction,
      suggestion: baseSuggestion,
      availableCategories,
      feedbackExamples,
      usedWebSearch: false,
      minimumConfidence: AI_WEB_FALLBACK_CONFIDENCE,
    });
  }
  return null;
}

async function requestCategorySuggestion(
  client: OpenAI,
  input: CategorizeInput,
  availableCategories: CategoryCandidate[],
  feedbackExamples: Awaited<ReturnType<typeof loadFeedbackExamples>>,
  useWebSearch: boolean,
): Promise<CategorySuggestion> {
  const env = getEnv();
  const response = await trackOpenAiCall(
    useWebSearch ? 'categorization_web' : 'categorization_base',
    env.OPENAI_CATEGORIZATION_MODEL,
    () => client.responses.parse({
      model: env.OPENAI_CATEGORIZATION_MODEL,
      ...categorizationWebToolOptions(useWebSearch),
      input: [{
        role: 'user',
        content: [{
          type: 'input_text',
          text: buildCategorizationPrompt(input, availableCategories, feedbackExamples, useWebSearch),
        }],
      }],
      text: {
        format: zodTextFormat(categorySuggestionSchema, 'category_suggestion'),
      },
    }),
  );

  const message = response.output.find((item) => item.type === 'message');
  const parsed = message?.content.find((item) => item.type === 'output_text')?.parsed;
  return categorySuggestionSchema.parse(parsed);
}

/**
 * Static instructions and the (per-business, rarely changing) category list come first
 * and the per-transaction data last, so OpenAI's automatic prefix caching can reuse the
 * long shared prefix across calls.
 */
export function buildCategorizationPrompt(
  input: Pick<CategorizeInput, 'merchant' | 'amountCents' | 'plaidCategory'>,
  availableCategories: CategoryCandidate[],
  feedbackExamples: unknown[],
  useWebSearch: boolean,
): string {
  const direction = input.amountCents > 0
    ? 'inflow/income'
    : input.amountCents < 0
      ? 'outflow/expense'
      : 'zero amount';
  return [
    'You are categorizing a business transaction for Ledger AI.',
    'Choose exactly one categoryId from the provided category list, or null if none fit.',
    'Never contradict the transaction direction given below.',
    'Prefer tax-oriented Schedule C categories over miscellaneous internal categories.',
    'Do not create new categories or tax codes. Accepted feedback is authoritative.',
    `Categories: ${JSON.stringify(availableCategories)}`,
    useWebSearch
      ? 'Use the one available web search to identify the exact merchant or domain and what it sells. Reject fuzzy, partial-name, fictional-character, and unrelated matches. If an exact business identity is not supported, return null with confidence at or below 0.5. Set needsWebSearch=false because this is already the web pass, and briefly cite the evidence in reason.'
      : 'Do not use web search. Set needsWebSearch=true only when the merchant identity is unfamiliar or ambiguous and identifying it would materially change the category. Otherwise set it false. Do not guess an identity.',
    `Accepted feedback examples: ${JSON.stringify(feedbackExamples)}`,
    `Transaction direction: ${direction}.`,
    `Transaction: ${JSON.stringify({
      merchant: input.merchant,
      amountCents: input.amountCents,
      plaidCategory: input.plaidCategory ?? [],
    })}`,
  ].join('\n');
}

/**
 * A human just decided this merchant's category: drop the cached AI verdict for the
 * (business, merchant, direction) so the next AI call re-judges with the new feedback
 * instead of replaying the stale answer for up to 30 days.
 */
export async function invalidateAiCategorizationCache(input: {
  businessId: string;
  merchant: string;
  amountCents: number;
}): Promise<void> {
  const normalizedMerchant = normalize(input.merchant);
  if (!normalizedMerchant) return;
  await db
    .delete(aiCategorizationCache)
    .where(and(
      eq(aiCategorizationCache.businessId, input.businessId),
      eq(aiCategorizationCache.normalizedMerchant, normalizedMerchant),
      eq(aiCategorizationCache.direction, aiCacheDirection(input.amountCents)),
    ));
}

async function saveAiCategorizationResult(input: {
  input: CategorizeInput;
  normalizedMerchant: string;
  direction: string;
  suggestion: CategorySuggestion;
  availableCategories: CategoryCandidate[];
  feedbackExamples: Awaited<ReturnType<typeof loadFeedbackExamples>>;
  usedWebSearch: boolean;
  minimumConfidence: number;
}): Promise<CategorizeResult | null> {
  const categoryId = acceptedCategoryId(
    input.suggestion,
    input.availableCategories,
    input.minimumConfidence,
  );
  await db
    .insert(aiCategorizationCache)
    .values({
      businessId: input.input.businessId,
      normalizedMerchant: input.normalizedMerchant,
      direction: input.direction,
      categoryId,
      confidence: input.suggestion.confidence.toFixed(4),
      reason: input.suggestion.reason,
      outcome: 'result',
      retryAfter: null,
      failureCount: 0,
    })
    .onConflictDoUpdate({
      target: [
        aiCategorizationCache.businessId,
        aiCategorizationCache.normalizedMerchant,
        aiCategorizationCache.direction,
      ],
      set: {
        categoryId,
        confidence: input.suggestion.confidence.toFixed(4),
        reason: input.suggestion.reason,
        outcome: 'result',
        retryAfter: null,
        failureCount: 0,
        updatedAt: new Date(),
      },
    });
  if (!categoryId) return null;
  return {
    categoryId,
    source: 'ai_suggested',
    confidence: input.suggestion.confidence,
    evidence: {
      reason: input.suggestion.reason,
      feedbackExamples: input.feedbackExamples,
      usedWebSearch: input.usedWebSearch,
    },
  };
}

function acceptedCategoryId(
  suggestion: CategorySuggestion,
  availableCategories: CategoryCandidate[],
  minimumConfidence: number,
): string | null {
  if (suggestion.confidence < minimumConfidence) return null;
  return availableCategories.some((category) => category.id === suggestion.categoryId)
    ? suggestion.categoryId
    : null;
}

async function cacheAiCategorizationFailure(input: {
  input: CategorizeInput;
  normalizedMerchant: string;
  direction: string;
  priorFailureCount: number;
}): Promise<void> {
  const failureCount = input.priorFailureCount + 1;
  const retryAfter = new Date(Date.now() + categorizationRetryDelayMs(failureCount));
  await db
    .insert(aiCategorizationCache)
    .values({
      businessId: input.input.businessId,
      normalizedMerchant: input.normalizedMerchant,
      direction: input.direction,
      categoryId: null,
      confidence: null,
      reason: 'openai_categorization_error',
      outcome: 'error',
      retryAfter,
      failureCount,
    })
    .onConflictDoUpdate({
      target: [
        aiCategorizationCache.businessId,
        aiCategorizationCache.normalizedMerchant,
        aiCategorizationCache.direction,
      ],
      set: {
        categoryId: null,
        confidence: null,
        reason: 'openai_categorization_error',
        outcome: 'error',
        retryAfter,
        failureCount,
        updatedAt: new Date(),
      },
    });
}

async function cacheAiCategorizationDeferred(
  input: CategorizeInput,
  normalizedMerchant: string,
  direction: string,
): Promise<void> {
  const retryAfter = new Date();
  retryAfter.setUTCHours(24, 0, 0, 0);
  await db
    .insert(aiCategorizationCache)
    .values({
      businessId: input.businessId,
      normalizedMerchant,
      direction,
      categoryId: null,
      confidence: null,
      reason: 'web_search_daily_budget_deferred',
      outcome: 'deferred',
      retryAfter,
      failureCount: 0,
    })
    .onConflictDoUpdate({
      target: [
        aiCategorizationCache.businessId,
        aiCategorizationCache.normalizedMerchant,
        aiCategorizationCache.direction,
      ],
      set: {
        categoryId: null,
        confidence: null,
        reason: 'web_search_daily_budget_deferred',
        outcome: 'deferred',
        retryAfter,
        failureCount: 0,
        updatedAt: new Date(),
      },
    });
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

const MATCH_KIND_SPECIFICITY: Record<string, number> = {
  merchant_exact: 0,
  merchant_contains: 1,
  plaid_category: 2,
  amount_range: 3,
};

/**
 * Rule precedence, first match wins:
 *   1. lower priority number
 *   2. business-specific before global
 *   3. user-confirmed before machine/seeded
 *   4. more specific match kind (exact > contains > plaid category > amount range)
 *   5. most recently updated
 */
export function compareRulePrecedence(
  a: { priority: number; businessId: string | null; userConfirmed?: boolean; matchKind: string; updatedAt?: Date },
  b: { priority: number; businessId: string | null; userConfirmed?: boolean; matchKind: string; updatedAt?: Date },
): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  const aGlobal = a.businessId == null ? 1 : 0;
  const bGlobal = b.businessId == null ? 1 : 0;
  if (aGlobal !== bGlobal) return aGlobal - bGlobal;
  const aTrusted = a.userConfirmed ? 0 : 1;
  const bTrusted = b.userConfirmed ? 0 : 1;
  if (aTrusted !== bTrusted) return aTrusted - bTrusted;
  const specificity = (MATCH_KIND_SPECIFICITY[a.matchKind] ?? 9) - (MATCH_KIND_SPECIFICITY[b.matchKind] ?? 9);
  if (specificity !== 0) return specificity;
  return (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0);
}

/** A rule a human created or confirmed is trusted regardless of its priority. */
export function ruleCategorySource(rule: { userConfirmed: boolean }): CategorySource {
  return rule.userConfirmed ? 'user_confirmed_rule' : 'auto_rule';
}

/**
 * Rule writes must point at a category the rule can actually use: owned by the rule's
 * business (or global), and — when the rule is being re-pointed — on the same side of the
 * income/spend line as its current target (transfer categories are allowed either way).
 * Returns an error message, or null when valid.
 */
export function validateRuleCategory(input: {
  ruleBusinessId: string | null;
  category: CategoryCandidate & { active?: boolean };
  previousCategory?: CategoryCandidate | null;
}): string | null {
  const { category } = input;
  if (category.active === false) return `"${category.name}" is archived.`;
  if (category.businessId !== null && category.businessId !== input.ruleBusinessId) {
    return input.ruleBusinessId === null
      ? `"${category.name}" belongs to one business — a global rule needs a global category.`
      : `"${category.name}" belongs to a different business.`;
  }
  const previous = input.previousCategory;
  if (
    previous
    && !isExcludedFromSpendCategory(previous)
    && !isExcludedFromSpendCategory(category)
    && isIncomeCategory(previous) !== isIncomeCategory(category)
  ) {
    return isIncomeCategory(previous)
      ? `This rule files income; "${category.name}" is a spend category.`
      : `This rule files spend; "${category.name}" is an income category.`;
  }
  return null;
}

/**
 * Words every merchant matched by a normalized merchant pattern must contain. Each token
 * of normalize(merchant) is a substring of lower(merchant), so if the pattern equals or is
 * contained in the normalized merchant, every pattern token appears in lower(merchant).
 * That makes an ILIKE-per-token SQL prefilter safe: it can only drop non-matches.
 */
export function merchantPatternTokens(pattern: string): string[] {
  return normalize(pattern).split(' ').filter(Boolean);
}

/** SQL prefilter for rows whose merchant could match a normalized merchant pattern. */
export function merchantPrefilterSql(merchantColumn: SQLWrapper, pattern: string): SQL {
  const tokens = merchantPatternTokens(pattern);
  if (tokens.length === 0) return sql`true`;
  return sql.join(tokens.map((token) => sql`${merchantColumn} ILIKE ${`%${token}%`}`), sql` AND `);
}
