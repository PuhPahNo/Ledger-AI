import type { QboContractor, QboContractorsReport, QboPaymentMethod } from '@/types/quickbooks';

/**
 * Display helpers for Reports › Contractors. Guidance only — the chip says "likely", never
 * "required", and the page footnote carries the server's not-tax-advice text.
 */

export type ThresholdTone = 'over' | 'near' | 'card' | 'under';

export interface ThresholdChip {
  tone: ThresholdTone;
  label: string;
}

/** "$2,000" from cents, no decimals. */
export function thresholdAmount(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString('en-US')}`;
}

/** Share of the threshold that counts as "getting close" (worth collecting a W-9 early). */
export const NEAR_THRESHOLD_SHARE = 0.75;

/**
 * 1099 threshold chip for one contractor. Card payments go on the processor's 1099-K, so only
 * `ytdReportableCents` counts; someone paid over the line only by card gets a "1099-K" chip.
 */
export function thresholdChip(
  contractor: Pick<QboContractor, 'ytdPaidCents' | 'ytdReportableCents' | 'threshold'>,
): ThresholdChip {
  const { cents, exact, meetsThreshold } = contractor.threshold;
  const line = `${exact ? '' : '~'}${thresholdAmount(cents)}`;
  if (meetsThreshold || contractor.ytdReportableCents >= cents) {
    return { tone: 'over', label: `Over ${line} · 1099 likely` };
  }
  if (contractor.ytdPaidCents >= cents) {
    return { tone: 'card', label: 'Card-paid · 1099-K' };
  }
  if (contractor.ytdReportableCents >= cents * NEAR_THRESHOLD_SHARE) {
    return { tone: 'near', label: `Near ${line}` };
  }
  return { tone: 'under', label: `Under ${line}` };
}

export function paymentMethodLabel(method: QboPaymentMethod | string | null | undefined): string {
  switch (method) {
    case 'check': return 'Check';
    case 'credit_card': return 'Card';
    case 'cash_ach': return 'ACH/cash';
    case 'deposit': return 'Deposit';
    case 'transfer': return 'Transfer';
    case 'bill': return 'Bill';
    case 'vendor_credit': return 'Vendor credit';
    default: return method ? String(method) : '—';
  }
}

export function receiptStatusLabel(status: string): { label: string; tone: 'ok' | 'warn' | 'none' } {
  switch (status) {
    case 'matched': return { label: 'Receipt', tone: 'ok' };
    case 'attached_in_quickbooks': return { label: 'In QuickBooks', tone: 'ok' };
    case 'waived':
    case 'not_needed': return { label: 'Not needed', tone: 'none' };
    case 'missing': return { label: 'Missing', tone: 'warn' };
    case 'pending': return { label: 'Pending', tone: 'warn' };
    default: return { label: '—', tone: 'none' };
  }
}

/** Contractors worth looking at first: over the line, then near it, then by amount. */
export function sortContractors(rows: QboContractor[]): QboContractor[] {
  const rank: Record<ThresholdTone, number> = { over: 0, near: 1, card: 2, under: 3 };
  return [...rows].sort((a, b) => (
    rank[thresholdChip(a).tone] - rank[thresholdChip(b).tone]
    || b.periodPaidCents - a.periodPaidCents
    || a.name.localeCompare(b.name)
  ));
}

/** Period totals across every company in the report (for the one-line summary). */
export function contractorTotals(report: Pick<QboContractorsReport, 'companies'>): { contractors: number; paidCents: number; likely1099: number; missingTaxId: number } {
  const rows = report.companies.flatMap((company) => company.contractors);
  return {
    contractors: rows.length,
    paidCents: rows.reduce((sum, row) => sum + row.periodPaidCents, 0),
    likely1099: rows.filter((row) => thresholdChip(row).tone === 'over').length,
    missingTaxId: rows.filter((row) => thresholdChip(row).tone === 'over' && !row.taxIdOnFile).length,
  };
}
