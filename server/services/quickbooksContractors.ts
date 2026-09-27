import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  categories,
  qboAccounts,
  qboAttachments,
  qboCompanies,
  qboTransactionLinks,
  qboTransactions,
  qboVendors,
  transactions,
  type QboTransactionLine,
} from '../db/schema.js';

/**
 * Contractors report: who is getting paid, how, and how much — with a 1099-NEC threshold flag.
 * GUIDANCE ONLY, not tax advice.
 */

/**
 * 1099-NEC/MISC reporting threshold by payment year, in cents. The One Big Beautiful Bill Act
 * (2025) raised it from $600 to $2,000 for payments made after 2025-12-31, indexed for inflation
 * after 2026 — later years reuse the latest known value until updated here.
 */
export const NEC_THRESHOLD_CENTS_BY_YEAR: Readonly<Record<number, number>> = {
  2024: 60_000,
  2025: 60_000,
  2026: 200_000,
};

export const THRESHOLD_GUIDANCE =
  'Guidance only, not tax advice. 1099-NEC threshold: $600 for payments through 2025, $2,000 for payments in 2026 '
  + '(indexed for inflation after 2026). Card/third-party-network payments are generally reported on 1099-K by the '
  + 'processor, so they are excluded from the reportable total. Confirm with your accountant.';

export function necThreshold(year: number): { cents: number; exact: boolean } {
  if (NEC_THRESHOLD_CENTS_BY_YEAR[year] != null) return { cents: NEC_THRESHOLD_CENTS_BY_YEAR[year], exact: true };
  const known = Object.keys(NEC_THRESHOLD_CENTS_BY_YEAR).map(Number).sort((a, b) => a - b);
  if (year < known[0]) return { cents: 60_000, exact: false };
  return { cents: NEC_THRESHOLD_CENTS_BY_YEAR[known[known.length - 1]], exact: false };
}

const CONTRACT_LABOR_NAME = /contract|1099|freelanc|subcontract/i;

export function isContractLaborAccount(account: { name: string; mappedCategoryName?: string | null }): boolean {
  return CONTRACT_LABOR_NAME.test(account.name) || (account.mappedCategoryName ?? '').toLowerCase() === 'contract labor';
}

export type ContractorReason = 'vendor_1099' | 'contract_labor_account';

export function classifyContractor(input: { vendor1099: boolean; paidFromContractLaborAccount: boolean }): ContractorReason[] {
  const reasons: ContractorReason[] = [];
  if (input.vendor1099) reasons.push('vendor_1099');
  if (input.paidFromContractLaborAccount) reasons.push('contract_labor_account');
  return reasons;
}

/** Card payments are reported by the processor (1099-K), not on the payer's 1099-NEC. */
export function isReportableMethod(method: string | null): boolean {
  return method !== 'credit_card';
}

export interface ContractorPaymentInput {
  qboTransactionId: string;
  entityType: string;
  vendorQboId: string;
  txnDate: string;
  amountCents: number;
  method: string | null;
  memo: string | null;
  docNumber: string | null;
  linkedTransactionId: string | null;
  ledgerReceiptStatus: string | null;
  qboAttachmentCount: number;
}

export interface ContractorVendorInput {
  qboId: string;
  displayName: string;
  vendor1099: boolean;
  hasTaxId: boolean;
}

export interface ContractorReportRow {
  vendorQboId: string;
  name: string;
  reasons: ContractorReason[];
  vendor1099: boolean;
  taxIdOnFile: boolean;
  periodPaidCents: number;
  periodPaymentCount: number;
  ytdPaidCents: number;
  ytdReportableCents: number;
  lastPaidDate: string | null;
  paymentMethods: string[];
  threshold: { year: number; cents: number; exact: boolean; meetsThreshold: boolean };
  payments: Array<ContractorPaymentInput & { receiptStatus: string }>;
}

export function paymentReceiptStatus(payment: Pick<ContractorPaymentInput, 'ledgerReceiptStatus' | 'qboAttachmentCount'>): string {
  if (payment.ledgerReceiptStatus === 'matched') return 'matched';
  if (payment.qboAttachmentCount > 0) return 'attached_in_quickbooks';
  return payment.ledgerReceiptStatus ?? 'none';
}

/**
 * Pure report builder. `contractLaborVendorIds` = vendors with any expense line on a
 * contract-labor account (direct purchases or bills). YTD is the calendar year of `to`.
 */
export function buildContractorReport(input: {
  vendors: ContractorVendorInput[];
  payments: ContractorPaymentInput[];
  contractLaborVendorIds: Set<string>;
  from: string;
  to: string;
}): ContractorReportRow[] {
  const year = Number(input.to.slice(0, 4));
  const ytdFrom = `${year}-01-01`;
  const threshold = necThreshold(year);
  const paymentsByVendor = new Map<string, ContractorPaymentInput[]>();
  for (const payment of input.payments) {
    const list = paymentsByVendor.get(payment.vendorQboId) ?? [];
    list.push(payment);
    paymentsByVendor.set(payment.vendorQboId, list);
  }

  const rows: ContractorReportRow[] = [];
  for (const vendor of input.vendors) {
    const reasons = classifyContractor({
      vendor1099: vendor.vendor1099,
      paidFromContractLaborAccount: input.contractLaborVendorIds.has(vendor.qboId),
    });
    if (!reasons.length) continue;
    const all = (paymentsByVendor.get(vendor.qboId) ?? []).slice().sort((a, b) => b.txnDate.localeCompare(a.txnDate));
    const period = all.filter((p) => p.txnDate >= input.from && p.txnDate <= input.to);
    const ytd = all.filter((p) => p.txnDate >= ytdFrom && p.txnDate <= input.to);
    const ytdReportableCents = ytd.filter((p) => isReportableMethod(p.method)).reduce((sum, p) => sum + p.amountCents, 0);
    if (!period.length && !ytd.length && !vendor.vendor1099) continue;
    rows.push({
      vendorQboId: vendor.qboId,
      name: vendor.displayName,
      reasons,
      vendor1099: vendor.vendor1099,
      taxIdOnFile: vendor.hasTaxId,
      periodPaidCents: period.reduce((sum, p) => sum + p.amountCents, 0),
      periodPaymentCount: period.length,
      ytdPaidCents: ytd.reduce((sum, p) => sum + p.amountCents, 0),
      ytdReportableCents,
      lastPaidDate: all.find((p) => p.txnDate <= input.to)?.txnDate ?? null,
      paymentMethods: Array.from(new Set(period.map((p) => p.method ?? 'unknown'))).sort(),
      threshold: { year, cents: threshold.cents, exact: threshold.exact, meetsThreshold: ytdReportableCents >= threshold.cents },
      payments: period.map((p) => ({ ...p, receiptStatus: paymentReceiptStatus(p) })),
    });
  }
  return rows.sort((a, b) => b.periodPaidCents - a.periodPaidCents || a.name.localeCompare(b.name));
}

function linesHitAccounts(lines: QboTransactionLine[], accountIds: Set<string>): boolean {
  return lines.some((line) => line.accountQboId && accountIds.has(line.accountQboId));
}

/** DB loader for the report; `businessId` null = every connected business. */
export async function contractorReport(input: { businessId: string | null; from: string; to: string }) {
  const companies = await db
    .select()
    .from(qboCompanies)
    .where(input.businessId ? and(eq(qboCompanies.businessId, input.businessId), eq(qboCompanies.active, true)) : eq(qboCompanies.active, true));
  const year = Number(input.to.slice(0, 4));
  const loadFrom = input.from < `${year}-01-01` ? input.from : `${year}-01-01`;

  const results = [];
  for (const company of companies) {
    const connectionId = company.connectionId;
    const accountRows = await db
      .select({ qboId: qboAccounts.qboId, name: qboAccounts.name, categoryName: categories.name })
      .from(qboAccounts)
      .leftJoin(categories, eq(qboAccounts.ledgerCategoryId, categories.id))
      .where(eq(qboAccounts.connectionId, connectionId));
    const contractAccountIds = new Set(accountRows
      .filter((a) => isContractLaborAccount({ name: a.name, mappedCategoryName: a.categoryName }))
      .map((a) => a.qboId));

    const vendorRows = await db.select().from(qboVendors).where(and(eq(qboVendors.connectionId, connectionId), eq(qboVendors.deleted, false)));
    const txnRows = await db
      .select()
      .from(qboTransactions)
      .where(and(eq(qboTransactions.connectionId, connectionId), eq(qboTransactions.deleted, false)));

    const billsById = new Map(txnRows.filter((t) => t.entityType === 'Bill').map((t) => [t.qboId, t]));
    const contractLaborVendorIds = new Set<string>();
    for (const txn of txnRows) {
      if (!txn.vendorQboId) continue;
      if ((txn.entityType === 'Purchase' || txn.entityType === 'Bill') && linesHitAccounts(txn.lines, contractAccountIds)) {
        contractLaborVendorIds.add(txn.vendorQboId);
      }
      // Bill payments inherit contract-labor classification from the bills they pay.
      if (txn.entityType === 'BillPayment') {
        for (const linked of txn.linkedTxns) {
          const bill = billsById.get(linked.txnId);
          if (bill && linesHitAccounts(bill.lines, contractAccountIds)) contractLaborVendorIds.add(txn.vendorQboId);
        }
      }
    }

    const paymentRows = txnRows.filter((t) => (t.entityType === 'Purchase' || t.entityType === 'BillPayment')
      && t.vendorQboId && t.txnDate >= loadFrom && t.txnDate <= input.to);
    const paymentIds = paymentRows.map((t) => t.id);
    const links = paymentIds.length
      ? await db
        .select({ qboTransactionId: qboTransactionLinks.qboTransactionId, transactionId: qboTransactionLinks.transactionId, receiptStatus: transactions.receiptStatus })
        .from(qboTransactionLinks)
        .innerJoin(transactions, eq(qboTransactionLinks.transactionId, transactions.id))
        .where(and(eq(qboTransactionLinks.status, 'linked'), inArray(qboTransactionLinks.qboTransactionId, paymentIds)))
      : [];
    const linkByQbo = new Map(links.map((l) => [l.qboTransactionId, l]));
    const attachmentRows = paymentIds.length
      ? await db
        .select({ qboTransactionId: qboAttachments.qboTransactionId })
        .from(qboAttachments)
        .where(and(eq(qboAttachments.deleted, false), inArray(qboAttachments.qboTransactionId, paymentIds)))
      : [];
    const attachmentCount = new Map<string, number>();
    for (const a of attachmentRows) if (a.qboTransactionId) attachmentCount.set(a.qboTransactionId, (attachmentCount.get(a.qboTransactionId) ?? 0) + 1);

    const payments: ContractorPaymentInput[] = paymentRows.map((t) => {
      const mainLeg = t.legs.find((l) => l.leg === 'main');
      // Money out is negative on the leg; a Purchase credit (refund) reduces the paid total.
      const amountCents = mainLeg ? -mainLeg.amountCents : t.totalCents;
      const link = linkByQbo.get(t.id);
      return {
        qboTransactionId: t.id,
        entityType: t.entityType,
        vendorQboId: t.vendorQboId!,
        txnDate: t.txnDate,
        amountCents,
        method: t.paymentMethod,
        memo: t.memo,
        docNumber: t.docNumber,
        linkedTransactionId: link?.transactionId ?? null,
        ledgerReceiptStatus: link?.receiptStatus ?? null,
        qboAttachmentCount: attachmentCount.get(t.id) ?? 0,
      };
    });

    results.push({
      connectionId,
      businessId: company.businessId,
      companyName: company.companyName,
      contractors: buildContractorReport({
        vendors: vendorRows.map((v) => ({ qboId: v.qboId, displayName: v.displayName, vendor1099: v.vendor1099, hasTaxId: v.hasTaxId })),
        payments,
        contractLaborVendorIds,
        from: input.from,
        to: input.to,
      }),
    });
  }
  return results;
}
