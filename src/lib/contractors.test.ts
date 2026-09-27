import { describe, expect, it } from 'vitest';
import type { QboContractor } from '@/types/quickbooks';
import { contractorTotals, paymentMethodLabel, sortContractors, thresholdChip } from './contractors';

const threshold = { year: 2026, cents: 200_000, exact: true, meetsThreshold: false };

function contractor(overrides: Partial<QboContractor> = {}): QboContractor {
  return {
    vendorQboId: 'v',
    name: 'Vendor',
    reasons: ['vendor_1099'],
    vendor1099: true,
    taxIdOnFile: false,
    periodPaidCents: 0,
    periodPaymentCount: 0,
    ytdPaidCents: 0,
    ytdReportableCents: 0,
    lastPaidDate: null,
    paymentMethods: [],
    threshold,
    payments: [],
    ...overrides,
  };
}

describe('thresholdChip', () => {
  it('flags contractors over the line as 1099 likely', () => {
    expect(thresholdChip(contractor({ ytdPaidCents: 240_000, ytdReportableCents: 240_000, threshold: { ...threshold, meetsThreshold: true } })))
      .toEqual({ tone: 'over', label: 'Over $2,000 · 1099 likely' });
  });
  it('trusts reportable totals even if the server flag is missing', () => {
    expect(thresholdChip(contractor({ ytdPaidCents: 200_000, ytdReportableCents: 200_000 })).tone).toBe('over');
  });
  it('excludes card payments (1099-K) from the line', () => {
    expect(thresholdChip(contractor({ ytdPaidCents: 240_000, ytdReportableCents: 0 })))
      .toEqual({ tone: 'card', label: 'Card-paid · 1099-K' });
  });
  it('warns when close to the line', () => {
    expect(thresholdChip(contractor({ ytdPaidCents: 160_000, ytdReportableCents: 160_000 }))).toEqual({ tone: 'near', label: 'Near $2,000' });
    expect(thresholdChip(contractor({ ytdPaidCents: 120_000, ytdReportableCents: 120_000 }))).toEqual({ tone: 'under', label: 'Under $2,000' });
  });
  it('marks an estimated threshold', () => {
    expect(thresholdChip(contractor({ threshold: { year: 2027, cents: 205_000, exact: false, meetsThreshold: false } })).label).toBe('Under ~$2,050');
  });
  it('uses the $600 line for older years', () => {
    expect(thresholdChip(contractor({ ytdReportableCents: 70_000, ytdPaidCents: 70_000, threshold: { year: 2025, cents: 60_000, exact: true, meetsThreshold: true } })).label)
      .toBe('Over $600 · 1099 likely');
  });
});

describe('sortContractors / totals', () => {
  const over = contractor({ vendorQboId: 'a', name: 'A', periodPaidCents: 100, ytdReportableCents: 250_000, ytdPaidCents: 250_000 });
  const under = contractor({ vendorQboId: 'b', name: 'B', periodPaidCents: 900_000, ytdReportableCents: 10_000, ytdPaidCents: 10_000 });
  const overWithId = contractor({ vendorQboId: 'c', name: 'C', periodPaidCents: 500, taxIdOnFile: true, ytdReportableCents: 300_000, ytdPaidCents: 300_000 });
  it('puts likely 1099s first, then by amount', () => {
    expect(sortContractors([under, over, overWithId]).map((row) => row.name)).toEqual(['C', 'A', 'B']);
  });
  it('counts likely 1099s missing a tax ID', () => {
    expect(contractorTotals({ companies: [{ connectionId: 'x', businessId: 'y', companyName: null, contractors: [over, under, overWithId] }] }))
      .toEqual({ contractors: 3, paidCents: 900_600, likely1099: 2, missingTaxId: 1 });
  });
});

describe('paymentMethodLabel', () => {
  it('names QuickBooks payment methods', () => {
    expect(paymentMethodLabel('cash_ach')).toBe('ACH/cash');
    expect(paymentMethodLabel('credit_card')).toBe('Card');
    expect(paymentMethodLabel(null)).toBe('—');
  });
});
