/**
 * Human-readable "why these belong together" lines for a receipt ↔ transaction pairing, derived
 * from the same scoring components the matcher uses (see `scoreMatch` in matching.ts). Pure: the
 * candidates list, the match queue, and the recently-matched list all render these.
 */

export type MatchReasonKind = 'amount' | 'date' | 'merchant' | 'card' | 'business';

/**
 * strong    — this signal alone points at the pair (exact amount, same day, card matches)
 * good      — supports the pair
 * weak      — barely supports it / not informative
 * conflict  — actively argues against the pair (different card, amount way off, dates far apart)
 */
export type MatchReasonStrength = 'strong' | 'good' | 'weak' | 'conflict';

export interface MatchReason {
  kind: MatchReasonKind;
  text: string;
  strength: MatchReasonStrength;
  /** The underlying 0–1 component score. */
  score: number;
}

export interface MatchReasonInput {
  receipt: {
    merchant: string | null;
    totalCents: number | null;
    receiptDate: string | null;
    businessId: string | null;
    /** Card last-4 printed on the receipt, when extraction found one. */
    cardLast4: string | null;
  };
  transaction: {
    merchant: string;
    amountCents: number;
    date: string;
    authorizedDate: string | null;
    businessId: string;
  };
  /** Last-4 of the transaction's account, when known. */
  accountMask: string | null;
  /** Component scores from `scoreMatch(...).reasons`. */
  components: Record<string, unknown>;
}

/** Ordered reasons (amount, date, merchant, card, business); signals we know nothing about are omitted. */
export function explainMatch(input: MatchReasonInput): MatchReason[] {
  const reasons: MatchReason[] = [];
  const amount = amountReason(input);
  if (amount) reasons.push(amount);
  const date = dateReason(input);
  if (date) reasons.push(date);
  const merchant = merchantReason(input);
  if (merchant) reasons.push(merchant);
  const card = cardReason(input);
  if (card) reasons.push(card);
  const business = businessReason(input);
  if (business) reasons.push(business);
  return reasons;
}

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function formatUsd(cents: number): string {
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  return `$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

function amountReason({ receipt, transaction, components }: MatchReasonInput): MatchReason | null {
  if (!receipt.totalCents) return null;
  const score = num(components.amountScore);
  const delta = Math.abs(Math.abs(receipt.totalCents) - Math.abs(transaction.amountCents));
  if (delta <= 2) return { kind: 'amount', text: 'Amount exact', strength: 'strong', score };
  const direction = Math.abs(receipt.totalCents) > Math.abs(transaction.amountCents) ? 'receipt higher' : 'receipt lower';
  return {
    kind: 'amount',
    text: `Amount off by ${formatUsd(delta)} (${direction})`,
    strength: score >= 0.5 ? 'good' : score > 0 ? 'weak' : 'conflict',
    score,
  };
}

function daysBetween(a: string, b: string): number {
  return Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

function dateReason({ receipt, transaction, components }: MatchReasonInput): MatchReason | null {
  if (!receipt.receiptDate) return null;
  const score = num(components.dateScore);
  const posted = daysBetween(receipt.receiptDate, transaction.date);
  const authorized = transaction.authorizedDate ? daysBetween(receipt.receiptDate, transaction.authorizedDate) : Infinity;
  const useAuthorized = components.dateBasis === 'authorized' || authorized < posted;
  const days = useAuthorized ? Math.min(authorized, posted) : posted;
  const base = days === 0 ? 'Same day' : `${days} day${days === 1 ? '' : 's'} apart`;
  const text = useAuthorized && authorized < posted ? `${base} (card authorization date)` : base;
  return {
    kind: 'date',
    text,
    strength: score >= 1 ? 'strong' : score >= 0.4 ? 'good' : score > 0 ? 'weak' : 'conflict',
    score,
  };
}

function merchantReason({ receipt, transaction, components }: MatchReasonInput): MatchReason | null {
  const receiptMerchant = receipt.merchant?.trim();
  if (!receiptMerchant) return null;
  const score = num(components.merchantScore);
  const txnMerchant = transaction.merchant.trim();
  if (score >= 0.9) {
    const same = receiptMerchant.toLowerCase() === txnMerchant.toLowerCase();
    return {
      kind: 'merchant',
      text: same ? `Merchant "${receiptMerchant}" matches` : `"${receiptMerchant}" ≈ "${txnMerchant}"`,
      strength: 'strong',
      score,
    };
  }
  if (score >= 0.3) {
    return { kind: 'merchant', text: `"${receiptMerchant}" partly matches "${txnMerchant}"`, strength: 'good', score };
  }
  // Bank descriptors often look nothing like the receipt payee, so a mismatch is weak, not a conflict.
  return { kind: 'merchant', text: `Merchant names differ ("${receiptMerchant}" vs "${txnMerchant}")`, strength: 'weak', score };
}

function last4(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function cardReason({ receipt, accountMask, components }: MatchReasonInput): MatchReason | null {
  const receiptCard = last4(receipt.cardLast4);
  const accountCard = last4(accountMask);
  if (!receiptCard || !accountCard) return null;
  const score = num(components.cardScore, receiptCard === accountCard ? 1 : 0);
  if (receiptCard === accountCard) {
    return { kind: 'card', text: `Card ••${receiptCard} matches`, strength: 'strong', score };
  }
  return {
    kind: 'card',
    text: `Different card ••${receiptCard} (charged to ••${accountCard})`,
    strength: 'conflict',
    score,
  };
}

function businessReason({ receipt, transaction, components }: MatchReasonInput): MatchReason | null {
  if (!receipt.businessId) return null;
  const score = num(components.businessScore);
  if (receipt.businessId === transaction.businessId) {
    return { kind: 'business', text: 'Same business', strength: 'good', score };
  }
  return { kind: 'business', text: 'Receipt is filed under a different business', strength: 'weak', score };
}
