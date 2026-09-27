import { normalize as defaultNormalize } from './categorization.js';

export interface TransactionOverrideInput {
  businessId?: string;
  categoryId?: string | null;
  note?: string | null;
}

export function normalizeTransactionOverride(input: TransactionOverrideInput): TransactionOverrideInput {
  return {
    ...(input.businessId ? { businessId: input.businessId } : {}),
    ...(input.categoryId !== undefined ? { categoryId: input.categoryId || null } : {}),
    ...(input.note !== undefined ? { note: input.note?.trim() || null } : {}),
  };
}

/**
 * Bulk edits learn once per merchant. Key by the same normalize() the rules engine and
 * AI cache use, so "SQ *BLUE BOTTLE 402" and "Blue Bottle" count as one merchant.
 */
export function manualCategoryFeedbackKey(
  transaction: { businessId: string; merchant: string; amountCents: number },
  normalizeMerchant: (value: string) => string = defaultNormalize,
): string {
  const direction = transaction.amountCents > 0 ? 'in' : 'out';
  return `${transaction.businessId}:${direction}:${normalizeMerchant(transaction.merchant)}`;
}

/** Learning prompts / feedback examples come from spend corrections only. */
export function shouldLearnFromManualCategory(amountCents: number, categoryIsIncome: boolean): boolean {
  return amountCents < 0 && !categoryIsIncome;
}
