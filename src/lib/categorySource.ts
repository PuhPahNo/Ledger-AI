import type { CategorySource } from '@/types/domain';

/**
 * How a transaction got its category, in words the owner can act on. Trusted sources
 * (human judgment) read differently from machine guesses so it's obvious what to review.
 */
export function categorySourceLabel(source?: CategorySource): string | null {
  switch (source) {
    case 'manual': return 'Set by you';
    case 'user_confirmed_rule': return 'Your rule';
    case 'auto_rule': return 'Rule';
    case 'plaid_signal': return 'Bank signal';
    case 'ai_suggested': return 'AI suggestion';
    case 'receipt_evidence': return 'From receipt';
    default: return null;
  }
}

/** True when the category came from a machine guess rather than human judgment. */
export function isGuessedCategorySource(source?: CategorySource): boolean {
  return source === 'auto_rule' || source === 'plaid_signal' || source === 'ai_suggested';
}

/** Short tag for table rows — only guessed sources get one, so trust gaps stand out. */
export function categorySourceTag(source?: CategorySource, confidence?: number): string | null {
  if (!isGuessedCategorySource(source)) return null;
  if (source === 'ai_suggested') {
    return confidence != null ? `AI ${Math.round(confidence * 100)}%` : 'AI';
  }
  return 'auto';
}
