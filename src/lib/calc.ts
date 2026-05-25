import type { BusinessId, Transaction } from '@/types/domain';

export function isExcludedFromSpend(txn: Transaction): boolean {
  return Boolean(txn.categoryTaxCode?.startsWith('exclude_')) || txn.cat.toLowerCase() === 'transfers';
}

export function isSpendTransaction(txn: Transaction): boolean {
  return txn.amount < 0 && !isExcludedFromSpend(txn);
}

/** Outflow total for a given business, returned as a negative number. */
export function spendForBusiness(txns: Transaction[], biz: BusinessId): number {
  return txns
    .filter((t) => t.biz === biz && isSpendTransaction(t))
    .reduce((a, t) => a + t.amount, 0);
}

/** Outflow total across all businesses, returned as a negative number. */
export function totalSpend(txns: Transaction[]): number {
  return txns.filter(isSpendTransaction).reduce((a, t) => a + t.amount, 0);
}

export function countNeedsReceipt(txns: Transaction[], biz: BusinessId): number {
  return txns.filter((t) => t.biz === biz && t.receipt === 'missing').length;
}

export function countDuplicateSubs(txns: Transaction[], biz: BusinessId): number {
  return txns.filter((t) => t.biz === biz && t.flag === 'dup-sub').length;
}
