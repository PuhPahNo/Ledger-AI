import type { Account, BusinessId, Transaction, TransactionDirection, TransactionRollup } from '@/types/domain';

export function isExcludedFromSpend(txn: Transaction): boolean {
  const category = txn.cat.toLowerCase();
  return isTransferTransaction(txn)
    || txn.categoryTaxCode === 'income'
    || category === 'transfers'
    || category === 'income'
    || category === 'revenue';
}

export function isTransferTransaction(txn: Transaction): boolean {
  return Boolean(txn.categoryTaxCode?.startsWith('exclude_')) || txn.cat.toLowerCase() === 'transfers';
}

export function isSpendTransaction(txn: Transaction): boolean {
  return txn.amount < 0 && !isExcludedFromSpend(txn);
}

export function transactionMatchesDirection(txn: Transaction, direction: TransactionDirection): boolean {
  switch (direction) {
    case 'inflow':
      return txn.amount > 0;
    case 'outflow':
      return txn.amount < 0;
    case 'operating-outflow':
      return isSpendTransaction(txn);
    case 'transfer':
      return isTransferTransaction(txn);
    default:
      return true;
  }
}

export function summarizeTransactions(txns: Transaction[]): TransactionRollup {
  return txns.reduce<TransactionRollup>((summary, txn) => {
    summary.rows += 1;
    const cents = Math.round(txn.amount * 100);
    const transfer = isTransferTransaction(txn);
    if (cents > 0) summary.inflowCents += cents;
    if (cents < 0) summary.outflowCents += Math.abs(cents);
    // Operating inflow = positive cash that isn't an internal transfer (revenue counts).
    if (cents > 0 && !transfer) summary.operatingInflowCents += cents;
    // Operating outflow = real spend (excludes transfers AND mis-signed income/refunds).
    if (isSpendTransaction(txn)) summary.operatingOutflowCents += Math.abs(cents);
    if (transfer) summary.transferCents += Math.abs(cents);
    summary.netCents += cents;
    if (txn.receipt === 'missing') summary.missingReceipts += 1;
    return summary;
  }, {
    rows: 0,
    inflowCents: 0,
    outflowCents: 0,
    operatingInflowCents: 0,
    operatingOutflowCents: 0,
    transferCents: 0,
    netCents: 0,
    missingReceipts: 0,
  });
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

export function summarizeAccountBalances(accounts: Account[]) {
  return accounts.reduce((summary, account) => {
    if (account.enabled) summary.watched += 1;
    else summary.ignored += 1;
    const current = account.currentBalanceCents ?? 0;
    const available = account.availableBalanceCents ?? 0;
    if (account.kind === 'credit') {
      summary.creditBalanceCents += current;
      summary.creditAvailableCents += available;
    } else {
      summary.bankBalanceCents += current;
      summary.bankAvailableCents += available;
    }
    summary.netCashCents = summary.bankBalanceCents - summary.creditBalanceCents;
    return summary;
  }, {
    bankBalanceCents: 0,
    bankAvailableCents: 0,
    creditBalanceCents: 0,
    creditAvailableCents: 0,
    netCashCents: 0,
    watched: 0,
    ignored: 0,
  });
}
