import type { BusinessId, Transaction } from '@/types/domain';

/** Outflow total for a given business, returned as a negative number. */
export function spendForBusiness(txns: Transaction[], biz: BusinessId): number {
  return txns
    .filter((t) => t.biz === biz && t.amount < 0)
    .reduce((a, t) => a + t.amount, 0);
}

/** Outflow total across all businesses, returned as a negative number. */
export function totalSpend(txns: Transaction[]): number {
  return txns.filter((t) => t.amount < 0).reduce((a, t) => a + t.amount, 0);
}

export function countNeedsReceipt(txns: Transaction[], biz: BusinessId): number {
  return txns.filter((t) => t.biz === biz && t.receipt === 'missing').length;
}

export function countDuplicateSubs(txns: Transaction[], biz: BusinessId): number {
  return txns.filter((t) => t.biz === biz && t.flag === 'dup-sub').length;
}
