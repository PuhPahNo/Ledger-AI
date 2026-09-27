import type { QboLinkedTxn, QboTransactionLeg, QboTransactionLine } from '../db/schema.js';
import type { QboEntity } from './quickbooksClient.js';

/**
 * Pure QBO-entity → Ledger-row normalization. No database, no network — unit tested.
 */

export const QBO_TRANSACTION_ENTITIES = ['Purchase', 'BillPayment', 'Bill', 'Deposit', 'Transfer', 'VendorCredit'] as const;
export type QboTransactionEntity = typeof QBO_TRANSACTION_ENTITIES[number];
export const QBO_SYNC_ENTITIES = ['Account', 'Vendor', ...QBO_TRANSACTION_ENTITIES, 'Attachable'] as const;

export type QboPaymentMethod =
  | 'check'
  | 'credit_card'
  | 'cash_ach'
  | 'deposit'
  | 'transfer'
  | 'bill'
  | 'vendor_credit';

export function toCents(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export function isDeletedEntity(entity: QboEntity): boolean {
  return String(entity?.status ?? '').toLowerCase() === 'deleted';
}

function ref(value: unknown): { value: string; name: string | null; type: string | null } | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (r.value == null || r.value === '') return null;
  return {
    value: String(r.value),
    name: typeof r.name === 'string' ? r.name : null,
    type: typeof r.type === 'string' ? r.type : null,
  };
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function metaTime(entity: QboEntity, key: 'CreateTime' | 'LastUpdatedTime'): Date | null {
  const raw = entity?.MetaData?.[key];
  if (typeof raw !== 'string') return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function lastFourDigits(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

// --- Accounts ----------------------------------------------------------------------------------

export interface NormalizedQboAccount {
  qboId: string;
  name: string;
  fullyQualifiedName: string | null;
  accountType: string | null;
  accountSubType: string | null;
  classification: string | null;
  acctNumLast4: string | null;
  active: boolean;
  currentBalanceCents: number | null;
  syncToken: string | null;
  qboUpdatedAt: Date | null;
}

export function normalizeAccount(entity: QboEntity): NormalizedQboAccount {
  // Last-4 from AcctNum when present, else a trailing 4-digit group in the name ("Chase ...1234").
  const nameDigits = String(entity.Name ?? '').match(/(\d{4})\D*$/)?.[1] ?? null;
  return {
    qboId: String(entity.Id),
    name: String(entity.Name ?? `Account ${entity.Id}`),
    fullyQualifiedName: text(entity.FullyQualifiedName),
    accountType: text(entity.AccountType),
    accountSubType: text(entity.AccountSubType),
    classification: text(entity.Classification),
    acctNumLast4: lastFourDigits(entity.AcctNum) ?? nameDigits,
    active: entity.Active !== false,
    currentBalanceCents: entity.CurrentBalance == null ? null : toCents(entity.CurrentBalance),
    syncToken: text(entity.SyncToken),
    qboUpdatedAt: metaTime(entity, 'LastUpdatedTime'),
  };
}

export function isBankOrCardAccountType(accountType: string | null | undefined): boolean {
  return accountType === 'Bank' || accountType === 'Credit Card';
}

export function isExpenseAccountType(accountType: string | null | undefined): boolean {
  return accountType === 'Expense' || accountType === 'Other Expense' || accountType === 'Cost of Goods Sold';
}

// --- Vendors -----------------------------------------------------------------------------------

export interface NormalizedQboVendor {
  qboId: string;
  displayName: string;
  companyName: string | null;
  vendor1099: boolean;
  hasTaxId: boolean;
  active: boolean;
  balanceCents: number | null;
  syncToken: string | null;
  qboUpdatedAt: Date | null;
}

/** The TaxIdentifier (masked by QBO anyway) is reduced to a boolean and never stored. */
export function normalizeVendor(entity: QboEntity): NormalizedQboVendor {
  return {
    qboId: String(entity.Id),
    displayName: String(entity.DisplayName ?? entity.CompanyName ?? `Vendor ${entity.Id}`),
    companyName: text(entity.CompanyName),
    vendor1099: entity.Vendor1099 === true,
    hasTaxId: typeof entity.TaxIdentifier === 'string' && entity.TaxIdentifier.trim().length > 0,
    active: entity.Active !== false,
    balanceCents: entity.Balance == null ? null : toCents(entity.Balance),
    syncToken: text(entity.SyncToken),
    qboUpdatedAt: metaTime(entity, 'LastUpdatedTime'),
  };
}

// --- Transactions ------------------------------------------------------------------------------

export interface NormalizedQboTransaction {
  entityType: QboTransactionEntity;
  qboId: string;
  txnDate: string;
  totalCents: number;
  paymentMethod: QboPaymentMethod | null;
  docNumber: string | null;
  memo: string | null;
  vendorQboId: string | null;
  payeeName: string | null;
  payeeType: string | null;
  bankAccountQboId: string | null;
  bankAccountName: string | null;
  legs: QboTransactionLeg[];
  lines: QboTransactionLine[];
  linkedTxns: QboLinkedTxn[];
  syncToken: string | null;
  qboCreatedAt: Date | null;
  qboUpdatedAt: Date | null;
}

function expenseLines(entity: QboEntity): QboTransactionLine[] {
  const lines: any[] = Array.isArray(entity.Line) ? entity.Line : [];
  const out: QboTransactionLine[] = [];
  for (const line of lines) {
    if (!line || line.DetailType === 'SubTotalLineDetail') continue;
    const accountDetail = line.AccountBasedExpenseLineDetail;
    const itemDetail = line.ItemBasedExpenseLineDetail;
    const depositDetail = line.DepositLineDetail;
    const account = ref(accountDetail?.AccountRef ?? depositDetail?.AccountRef);
    if (!account && !itemDetail && !depositDetail) continue;
    out.push({
      amountCents: toCents(line.Amount),
      accountQboId: account?.value ?? null,
      accountName: account?.name ?? (itemDetail ? text(itemDetail?.ItemRef?.name) : null),
      description: text(line.Description),
    });
  }
  return out;
}

function linkedTxns(entity: QboEntity): QboLinkedTxn[] {
  const out: QboLinkedTxn[] = [];
  const push = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (item?.TxnId != null) out.push({ txnId: String(item.TxnId), txnType: String(item.TxnType ?? '') });
    }
  };
  push(entity.LinkedTxn);
  for (const line of Array.isArray(entity.Line) ? entity.Line : []) push(line?.LinkedTxn);
  return out;
}

export function normalizeTransaction(entityType: QboTransactionEntity, entity: QboEntity): NormalizedQboTransaction {
  const base = {
    entityType,
    qboId: String(entity.Id),
    txnDate: String(entity.TxnDate ?? '').slice(0, 10),
    docNumber: text(entity.DocNumber),
    memo: text(entity.PrivateNote) ?? text(entity.Memo),
    syncToken: text(entity.SyncToken),
    qboCreatedAt: metaTime(entity, 'CreateTime'),
    qboUpdatedAt: metaTime(entity, 'LastUpdatedTime'),
    linkedTxns: linkedTxns(entity),
  };

  if (entityType === 'Purchase') {
    const account = ref(entity.AccountRef);
    const payee = ref(entity.EntityRef);
    const total = toCents(entity.TotalAmt);
    // Credit=true on a Purchase is a refund/credit back to the account (money in).
    const signed = entity.Credit === true ? total : -total;
    const paymentType = String(entity.PaymentType ?? '');
    return {
      ...base,
      totalCents: total,
      paymentMethod: paymentType === 'Check' ? 'check' : paymentType === 'CreditCard' ? 'credit_card' : 'cash_ach',
      vendorQboId: payee && (payee.type === 'Vendor' || payee.type == null) ? payee.value : null,
      payeeName: payee?.name ?? null,
      payeeType: payee?.type ?? null,
      bankAccountQboId: account?.value ?? null,
      bankAccountName: account?.name ?? null,
      legs: account ? [{ leg: 'main', accountQboId: account.value, amountCents: signed }] : [],
      lines: expenseLines(entity),
    };
  }

  if (entityType === 'BillPayment') {
    const payType = String(entity.PayType ?? '');
    const account = payType === 'CreditCard'
      ? ref(entity.CreditCardPayment?.CCAccountRef)
      : ref(entity.CheckPayment?.BankAccountRef);
    const vendor = ref(entity.VendorRef);
    const total = toCents(entity.TotalAmt);
    return {
      ...base,
      totalCents: total,
      paymentMethod: payType === 'CreditCard' ? 'credit_card' : 'check',
      vendorQboId: vendor?.value ?? null,
      payeeName: vendor?.name ?? null,
      payeeType: 'Vendor',
      bankAccountQboId: account?.value ?? null,
      bankAccountName: account?.name ?? null,
      legs: account ? [{ leg: 'main', accountQboId: account.value, amountCents: -total }] : [],
      lines: [],
    };
  }

  if (entityType === 'Deposit') {
    const account = ref(entity.DepositToAccountRef);
    const total = toCents(entity.TotalAmt);
    const lines = expenseLines(entity);
    const firstEntity = (Array.isArray(entity.Line) ? entity.Line : [])
      .map((line: any) => ref(line?.DepositLineDetail?.Entity))
      .find(Boolean) ?? null;
    return {
      ...base,
      totalCents: total,
      paymentMethod: 'deposit',
      vendorQboId: firstEntity?.type === 'Vendor' ? firstEntity.value : null,
      payeeName: firstEntity?.name ?? null,
      payeeType: firstEntity?.type ?? null,
      bankAccountQboId: account?.value ?? null,
      bankAccountName: account?.name ?? null,
      legs: account ? [{ leg: 'main', accountQboId: account.value, amountCents: total }] : [],
      lines,
    };
  }

  if (entityType === 'Transfer') {
    const from = ref(entity.FromAccountRef);
    const to = ref(entity.ToAccountRef);
    const amount = toCents(entity.Amount);
    const legs: QboTransactionLeg[] = [];
    if (from) legs.push({ leg: 'from', accountQboId: from.value, amountCents: -amount });
    if (to) legs.push({ leg: 'to', accountQboId: to.value, amountCents: amount });
    return {
      ...base,
      totalCents: amount,
      paymentMethod: 'transfer',
      vendorQboId: null,
      payeeName: to?.name ? `Transfer to ${to.name}` : null,
      payeeType: null,
      bankAccountQboId: from?.value ?? null,
      bankAccountName: from?.name ?? null,
      legs,
      lines: [],
    };
  }

  // Bill and VendorCredit: accounts-payable documents, no bank/card movement.
  const vendor = ref(entity.VendorRef);
  return {
    ...base,
    totalCents: toCents(entity.TotalAmt),
    paymentMethod: entityType === 'Bill' ? 'bill' : 'vendor_credit',
    vendorQboId: vendor?.value ?? null,
    payeeName: vendor?.name ?? null,
    payeeType: 'Vendor',
    bankAccountQboId: null,
    bankAccountName: null,
    legs: [],
    lines: expenseLines(entity),
  };
}

// --- Attachables -------------------------------------------------------------------------------

export interface NormalizedQboAttachable {
  qboId: string;
  fileName: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  note: string | null;
  entityRefs: Array<{ type: string; value: string }>;
  tempDownloadUri: string | null;
  syncToken: string | null;
  qboUpdatedAt: Date | null;
}

export function normalizeAttachable(entity: QboEntity): NormalizedQboAttachable {
  const refs: any[] = Array.isArray(entity.AttachableRef) ? entity.AttachableRef : [];
  return {
    qboId: String(entity.Id),
    fileName: text(entity.FileName),
    contentType: text(entity.ContentType),
    sizeBytes: entity.Size == null ? null : Number(entity.Size),
    note: text(entity.Note),
    entityRefs: refs
      .map((r) => ref(r?.EntityRef))
      .filter((r): r is NonNullable<typeof r> => Boolean(r?.type))
      .map((r) => ({ type: r.type!, value: r.value })),
    tempDownloadUri: text(entity.TempDownloadUri),
    syncToken: text(entity.SyncToken),
    qboUpdatedAt: metaTime(entity, 'LastUpdatedTime'),
  };
}

/** Transaction entity types an attachment can be imported from. */
export function attachableTransactionRef(refs: Array<{ type: string; value: string }>): { type: QboTransactionEntity; value: string } | null {
  for (const r of refs) {
    if ((QBO_TRANSACTION_ENTITIES as readonly string[]).includes(r.type)) {
      return { type: r.type as QboTransactionEntity, value: r.value };
    }
  }
  return null;
}
