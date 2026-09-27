import { Fragment, useEffect, useState } from 'react';
import { ArrowRight, Check, ChevronDown, ChevronUp, Minus, Users } from 'lucide-react';
import { getQuickbooksContractors } from '@/api/quickbooks';
import type { QboContractor, QboContractorPayment, QboContractorsReport } from '@/types/quickbooks';
import { parseLocalIsoDate, shiftIsoDays, todayIso } from '@/lib/dates';
import { fmt$, fmtWholeCents } from '@/lib/format';
import {
  contractorTotals,
  paymentMethodLabel,
  receiptStatusLabel,
  sortContractors,
  thresholdAmount,
  thresholdChip,
  type ThresholdChip,
} from '@/lib/contractors';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { ReportCard } from './ReportCard';
import type { ReportTabProps } from './reportTabs';

type Period = 'ytd' | 'quarter' | 'last-year';

const PERIODS: Array<{ id: Period; label: string }> = [
  { id: 'ytd', label: 'This year' },
  { id: 'quarter', label: 'This quarter' },
  { id: 'last-year', label: 'Last year' },
];

function periodRange(period: Period, today = todayIso()): { from: string; to: string } {
  const year = Number(today.slice(0, 4));
  if (period === 'last-year') return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` };
  if (period === 'quarter') {
    const quarterStartMonth = Math.floor((Number(today.slice(5, 7)) - 1) / 3) * 3 + 1;
    return { from: `${year}-${String(quarterStartMonth).padStart(2, '0')}-01`, to: today };
  }
  return { from: `${year}-01-01`, to: today };
}

function shortDate(iso: string | null): string {
  if (!iso) return '—';
  return parseLocalIsoDate(iso.slice(0, 10)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Reports › Contractors: who was paid (from QuickBooks), how much this period and year to date,
 * and whether they're likely over the 1099-NEC line. Guidance only; the footnote says so.
 */
export function ContractorsReport({ business, businesses, onViewChange, onOpenTransactions }: ReportTabProps) {
  const [period, setPeriod] = useState<Period>('ytd');
  const [report, setReport] = useState<QboContractorsReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const { from, to } = periodRange(period);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    getQuickbooksContractors({ biz: business, from, to })
      .then((result) => !cancelled && setReport(result))
      .catch((loadError: Error) => !cancelled && setError(loadError.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [business, from, to]);

  const openPayment = (companyBusinessId: string, payment: QboContractorPayment) => {
    const key = business !== 'all'
      ? business
      : businesses.find((item) => item.dbId === companyBusinessId)?.id;
    // Bank dates trail the books by a few days (checks clear later), so open a small window.
    onOpenTransactions?.({
      business: key,
      from: shiftIsoDays(payment.txnDate, -4),
      to: shiftIsoDays(payment.txnDate, 10),
      direction: 'outflow',
    });
  };

  const notConnected = report !== null && report.companies.length === 0;
  const totals = report ? contractorTotals(report) : null;
  const multipleCompanies = (report?.companies.length ?? 0) > 1;

  return (
    <ReportCard
      eyebrow="QuickBooks"
      title="Contractors"
      error={error}
      action={notConnected ? undefined : (
        <div role="tablist" aria-label="Contractor period" className="flex rounded-full bg-[hsl(var(--color-sunken))] p-1">
          {PERIODS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={period === item.id}
              onClick={() => setPeriod(item.id)}
              className={cn(
                'inline-flex min-h-10 items-center rounded-full px-3 text-xs font-bold transition-colors sm:min-h-8',
                period === item.id ? 'bg-inverse text-inverse-foreground' : 'text-dim hover:text-ink',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    >
      {!report ? (
        <div className="grid gap-2" aria-hidden="true">
          {[0, 1, 2, 3].map((index) => <Skeleton key={index} className="h-12" />)}
        </div>
      ) : notConnected ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[hsl(var(--color-sunken))] px-4 py-3">
          <span className="text-sm text-dim">Connect QuickBooks to see who you paid and who's likely due a 1099.</span>
          <Button variant="outline" size="sm" onClick={() => onViewChange?.({ view: 'settings', section: 'businesses' })}>
            Go to Settings
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : (
        <div className={cn('grid gap-4 transition-opacity', loading && 'opacity-60')} aria-busy={loading}>
          {totals && totals.contractors > 0 && (
            <p className="text-sm text-dim">
              <span className="font-bold text-ink">{fmtWholeCents(totals.paidCents)}</span> to {totals.contractors} contractor{totals.contractors === 1 ? '' : 's'}
              {totals.likely1099 > 0 && (
                <> · <span className="font-bold text-ink">{totals.likely1099}</span> likely need a 1099</>
              )}
              {totals.missingTaxId > 0 && (
                <> · <span className="font-bold text-coral-ink">{totals.missingTaxId} missing a tax ID</span></>
              )}
            </p>
          )}
          {report.companies.map((company) => (
            <section key={company.connectionId} className="grid gap-2">
              {multipleCompanies && <h3 className="text-xs font-bold uppercase tracking-wider text-dim">{company.companyName ?? 'QuickBooks company'}</h3>}
              {company.contractors.length === 0 ? (
                <EmptyState
                  icon={<Users className="h-5 w-5" />}
                  title="No contractor payments"
                  description="Nobody flagged as a 1099 vendor or paid from a contract-labor account in this period."
                />
              ) : (
                <ContractorTable
                  contractors={sortContractors(company.contractors)}
                  onOpenPayment={(payment) => openPayment(company.businessId, payment)}
                />
              )}
            </section>
          ))}
          <p className="text-[11px] leading-relaxed text-dim">
            <span className="font-bold">{report.threshold.year} line: {report.threshold.exact ? '' : '~'}{thresholdAmount(report.threshold.cents)}.</span>
            {' '}{report.threshold.guidance}
          </p>
        </div>
      )}
    </ReportCard>
  );
}

const CHIP_CLASS: Record<ThresholdChip['tone'], string> = {
  over: 'bg-lemon text-lemon-ink',
  near: 'bg-sky/40 text-sky-ink dark:bg-sky/20 dark:text-sky',
  card: 'bg-ink/5 text-dim',
  under: 'bg-ink/5 text-dim',
};

function ThresholdBadge({ contractor }: { contractor: QboContractor }) {
  const chip = thresholdChip(contractor);
  return <span className={cn('inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-bold', CHIP_CLASS[chip.tone])}>{chip.label}</span>;
}

function TaxId({ contractor }: { contractor: QboContractor }) {
  if (contractor.taxIdOnFile) return <Check className="h-4 w-4 text-sage-ink" aria-label="Tax ID on file" />;
  const needed = thresholdChip(contractor).tone === 'over';
  return needed
    ? <span className="text-xs font-bold text-coral-ink">Missing</span>
    : <Minus className="h-4 w-4 text-dim" aria-label="No tax ID on file" />;
}

function methodsText(contractor: QboContractor): string {
  return contractor.paymentMethods.map(paymentMethodLabel).join(', ') || '—';
}

function ContractorTable({ contractors, onOpenPayment }: { contractors: QboContractor[]; onOpenPayment: (payment: QboContractorPayment) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const toggle = (id: string) => setOpen((value) => (value === id ? null : id));
  return (
    <>
      {/* Desktop / tablet: a table. */}
      <div className="hidden md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink2/10 text-left text-[11px] font-bold uppercase tracking-wider text-dim">
              <th className="py-2 pr-3 font-bold">Contractor</th>
              <th className="py-2 pr-3 text-right font-bold">Period</th>
              <th className="py-2 pr-3 text-right font-bold">YTD</th>
              <th className="hidden py-2 pr-3 text-right font-bold lg:table-cell">Payments</th>
              <th className="py-2 pr-3 font-bold">Last paid</th>
              <th className="hidden py-2 pr-3 font-bold lg:table-cell">Method</th>
              <th className="py-2 pr-3 text-center font-bold">Tax ID</th>
              <th className="py-2 pr-1 font-bold">1099</th>
            </tr>
          </thead>
          <tbody>
            {contractors.map((contractor) => {
              const expanded = open === contractor.vendorQboId;
              return (
                <Fragment key={contractor.vendorQboId}>
                  <tr
                    className="cursor-pointer border-b border-ink2/10 hover:bg-ink/[0.03]"
                    onClick={() => toggle(contractor.vendorQboId)}
                  >
                    <td className="py-2 pr-3">
                      <button
                        type="button"
                        aria-expanded={expanded}
                        className="flex items-center gap-1.5 text-left font-bold text-ink"
                        onClick={(event) => {
                          event.stopPropagation();
                          toggle(contractor.vendorQboId);
                        }}
                      >
                        {expanded ? <ChevronUp className="h-3.5 w-3.5 text-dim" /> : <ChevronDown className="h-3.5 w-3.5 text-dim" />}
                        {contractor.name}
                      </button>
                    </td>
                    <td className="py-2 pr-3 text-right font-mono">{fmtWholeCents(contractor.periodPaidCents)}</td>
                    <td className="py-2 pr-3 text-right font-mono text-dim">{fmtWholeCents(contractor.ytdPaidCents)}</td>
                    <td className="hidden py-2 pr-3 text-right lg:table-cell">{contractor.periodPaymentCount}</td>
                    <td className="py-2 pr-3 text-dim">{shortDate(contractor.lastPaidDate)}</td>
                    <td className="hidden py-2 pr-3 text-dim lg:table-cell">{methodsText(contractor)}</td>
                    <td className="py-2 pr-3"><span className="flex justify-center"><TaxId contractor={contractor} /></span></td>
                    <td className="py-2 pr-1"><ThresholdBadge contractor={contractor} /></td>
                  </tr>
                  {expanded && (
                    <tr className="border-b border-ink2/10">
                      <td colSpan={8} className="pb-3 pt-1">
                        <PaymentList payments={contractor.payments} onOpen={onOpenPayment} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Phones: stacked rows. */}
      <ul className="divide-y divide-ink2/10 md:hidden">
        {contractors.map((contractor) => {
          const expanded = open === contractor.vendorQboId;
          return (
            <li key={contractor.vendorQboId} className="py-2">
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => toggle(contractor.vendorQboId)}
                className="grid min-h-10 w-full gap-1 text-left"
              >
                <span className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-bold text-ink">{contractor.name}</span>
                  <span className="shrink-0 font-mono text-sm text-ink">{fmtWholeCents(contractor.periodPaidCents)}</span>
                </span>
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-dim">
                  <ThresholdBadge contractor={contractor} />
                  <span>YTD {fmtWholeCents(contractor.ytdPaidCents)}</span>
                </span>
                <span className="flex flex-wrap items-center gap-x-1.5 text-xs text-dim">
                  <span>{contractor.periodPaymentCount} paid · last {shortDate(contractor.lastPaidDate)} · {methodsText(contractor)} ·</span>
                  <span className="inline-flex items-center gap-1">Tax ID <TaxId contractor={contractor} /></span>
                </span>
              </button>
              {expanded && <div className="mt-2"><PaymentList payments={contractor.payments} onOpen={onOpenPayment} /></div>}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function PaymentList({ payments, onOpen }: { payments: QboContractorPayment[]; onOpen: (payment: QboContractorPayment) => void }) {
  if (!payments.length) return <p className="px-2 text-xs text-dim">No payments in this period.</p>;
  return (
    <ul className="divide-y divide-ink2/10 rounded-lg bg-[hsl(var(--color-sunken))] text-xs">
      {payments.map((payment) => {
        const receipt = receiptStatusLabel(payment.receiptStatus);
        return (
          <li key={payment.qboTransactionId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5">
            <span className="w-14 shrink-0 font-mono text-dim">{shortDate(payment.txnDate)}</span>
            <span className="w-20 shrink-0 text-right font-mono text-ink">{fmt$(payment.amountCents / 100)}</span>
            <span className="shrink-0 text-dim">
              {paymentMethodLabel(payment.method)}{payment.docNumber ? ` #${payment.docNumber}` : ''}
            </span>
            <span className="min-w-0 flex-1 basis-32 truncate text-dim">{payment.memo ?? ''}</span>
            <span
              className={cn(
                'shrink-0 font-bold',
                receipt.tone === 'ok' && 'text-sage-ink',
                receipt.tone === 'warn' && 'text-coral-ink',
                receipt.tone === 'none' && 'text-dim',
              )}
            >
              {receipt.tone === 'warn' ? `Receipt ${receipt.label.toLowerCase()}` : receipt.label}
            </span>
            {payment.linkedTransactionId ? (
              <Button variant="ghost" size="sm" className="-my-1 h-10 shrink-0 px-2 sm:h-7" onClick={() => onOpen(payment)}>
                Open
                <ArrowRight className="h-3 w-3" />
              </Button>
            ) : (
              <span className="shrink-0 text-dim">Not in Ledger</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
