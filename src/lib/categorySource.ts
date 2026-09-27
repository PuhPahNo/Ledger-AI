import type { CategorySource } from '@/types/domain';
import type { AutomationCategorySource } from '@/types/automation';

type AnyCategorySource = CategorySource | AutomationCategorySource;

/**
 * How a transaction got its category, in words the owner can act on. Trusted sources
 * (human judgment) read differently from machine guesses so it's obvious what to review.
 * Pass the transaction's categoryEvidence to name the external system (e.g. QuickBooks).
 */
export function categorySourceLabel(source?: AnyCategorySource, evidence?: Record<string, unknown>): string | null {
  switch (source) {
    case 'manual': return 'Set by you';
    case 'user_confirmed_rule': return evidence?.learningEventId ? 'Learned rule' : 'Your rule';
    case 'auto_rule': return 'Rule';
    case 'plaid_signal': return 'Bank signal';
    case 'ai_suggested': return 'AI suggestion';
    case 'receipt_evidence': return 'From receipt';
    case 'external_signal': return externalSignalLabel(evidence);
    default: return null;
  }
}

function externalSignalLabel(evidence?: Record<string, unknown>): string {
  const signalSource = typeof evidence?.signalSource === 'string' ? evidence.signalSource : null;
  if (signalSource === 'quickbooks') return 'From QuickBooks';
  return signalSource ? `From ${signalSource.charAt(0).toUpperCase()}${signalSource.slice(1)}` : 'External signal';
}

/** True when the category came from a machine guess rather than human judgment. */
export function isGuessedCategorySource(source?: AnyCategorySource): boolean {
  return source === 'auto_rule' || source === 'plaid_signal' || source === 'ai_suggested' || source === 'external_signal';
}

/** Short tag for table rows — only guessed sources get one, so trust gaps stand out. */
export function categorySourceTag(source?: AnyCategorySource, confidence?: number, evidence?: Record<string, unknown>): string | null {
  if (!isGuessedCategorySource(source)) return null;
  if (source === 'ai_suggested') {
    return confidence != null ? `AI ${Math.round(confidence * 100)}%` : 'AI';
  }
  if (source === 'external_signal') return evidence?.signalSource === 'quickbooks' ? 'QBO' : 'ext';
  return 'auto';
}
