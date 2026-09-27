import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Boxes,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Receipt as ReceiptIcon,
  TriangleAlert,
} from 'lucide-react';
import { createExport, getCloseReadiness, signOffClosePeriod, type CloseReadiness } from '@/api';
import type { CloseReadinessItem } from '@/types/domain';
import type { TransactionViewFilters } from '@/types/navigation';
import { currentMonthKey, formatMonthLabel, monthBounds, shiftMonthKey } from '@/lib/dates';
import { resolveNavTarget } from '@/lib/routes';
import { cn } from '@/lib/cn';
import { useToast } from '@/hooks/useToast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ReportCard } from './ReportCard';
import type { ReportTabProps } from './reportTabs';

/**
 * Reports › Close: the month-close checklist for one calendar month, sign-off, and the audit
 * export. Defaults to last month — the one usually being closed.
 */
export function CloseReport({ business, businesses, onViewChange, onOpenTransactions }: ReportTabProps) {
  const { toast } = useToast();
  const [month, setMonth] = useState(() => shiftMonthKey(currentMonthKey(), -1));
  const [readiness, setReadiness] = useState<CloseReadiness | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'sign-off' | 'export' | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const { from, to } = monthBounds(month);
  const monthLabel = formatMonthLabel(month);
  const businessDbId = business === 'all' ? null : businesses.find((item) => item.id === business)?.dbId ?? null;

  useEffect(() => {
    let cancelled = false;
    setError('');
    getCloseReadiness({ from, to, biz: business })
      .then((result) => !cancelled && setReadiness(result))
      .catch((loadError: Error) => !cancelled && setError(loadError.message));
    return () => {
      cancelled = true;
    };
  }, [business, from, to, refreshKey]);

  const signOff = async () => {
    setBusy('sign-off');
    try {
      setReadiness(await signOffClosePeriod({ from, to, biz: business }));
      toast({ variant: 'success', title: `${monthLabel} signed off`, description: 'Later edits in this month will be flagged here.' });
    } catch (signOffError) {
      toast({ variant: 'destructive', title: 'Sign-off blocked', description: signOffError instanceof Error ? signOffError.message : 'Clear the blockers first.' });
    } finally {
      setBusy(null);
    }
  };

  const queueExport = async () => {
    setBusy('export');
    try {
      await createExport(from, to, businessDbId);
      toast({ variant: 'success', title: 'Audit export queued', description: `${monthLabel} — download it from Settings › Data when it's ready.` });
      setRefreshKey((key) => key + 1);
    } catch (exportError) {
      toast({ variant: 'destructive', title: 'Export failed', description: exportError instanceof Error ? exportError.message : 'Try again.' });
    } finally {
      setBusy(null);
    }
  };

  const openItem = (item: CloseReadinessItem) => {
    if (item.id === 'sign-off') return void signOff();
    if (item.id === 'export') return void queueExport();
    if (item.actionView === 'transactions') {
      const filters = item.filters ?? {};
      onOpenTransactions?.({
        business,
        from: typeof filters.from === 'string' ? filters.from : from,
        to: typeof filters.to === 'string' ? filters.to : to,
        direction: typeof filters.direction === 'string' ? filters.direction as TransactionViewFilters['direction'] : undefined,
        receipts: Array.isArray(filters.receipts) ? filters.receipts as TransactionViewFilters['receipts'] : undefined,
        categories: Array.isArray(filters.categories) ? filters.categories : undefined,
      });
      return;
    }
    onViewChange?.(resolveNavTarget(item.actionView, item.filters));
  };

  const items = readiness?.items ?? [];
  const blockers = items.filter((item) => item.severity === 'blocker').length;
  const exportItem = items.find((item) => item.id === 'export');
  const checklist = items.filter((item) => item.id !== 'export' && item.id !== 'sign-off');

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-full bg-paper p-1 shadow-xs">
          <Button variant="ghost" size="icon-sm" onClick={() => setMonth((value) => shiftMonthKey(value, -1))} aria-label="Previous month">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Input
            type="month"
            value={month}
            max={currentMonthKey()}
            aria-label="Month to close"
            onChange={(event) => event.target.value && setMonth(event.target.value)}
            className="h-10 w-[9.5rem] rounded-full border-transparent bg-transparent px-2 text-xs font-bold sm:h-8"
          />
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={month >= currentMonthKey()}
            onClick={() => setMonth((value) => shiftMonthKey(value, 1))}
            aria-label="Next month"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        {business !== 'all' && <span className="text-xs text-dim">{businesses.find((item) => item.id === business)?.name}</span>}
      </div>

      <ReportCard
        eyebrow={`Month close · ${monthLabel}`}
        title={!readiness
          ? 'Checking…'
          : readiness.signedOff
            ? `${monthLabel} is signed off`
            : blockers > 0
              ? `${blockers} blocker${blockers === 1 ? '' : 's'} before sign-off`
              : 'Ready to sign off'}
        error={error || undefined}
        action={readiness?.canSignOff ? (
          <Button size="sm" onClick={() => void signOff()} disabled={busy !== null}>
            <CheckCircle className="h-3.5 w-3.5" />
            Sign off {formatMonthLabel(month, 'short')}
          </Button>
        ) : undefined}
      >
        {!readiness ? (
          <Skeleton className="h-40" />
        ) : readiness.signedOff ? (
          (readiness.changedSinceSignOff ?? 0) > 0 ? (
            <div className="rounded-lg bg-coral/15 p-4 text-sm text-coral-ink">
              <div className="flex items-center gap-2 font-bold">
                <AlertTriangle className="h-4 w-4" />
                {readiness.changedSinceSignOff} transaction{readiness.changedSinceSignOff === 1 ? '' : 's'} changed since sign-off
              </div>
              <div className="mt-1 text-xs">Added or edited after {monthLabel} was signed off{readiness.signedOffAt ? ` (${new Date(readiness.signedOffAt).toLocaleDateString()})` : ''} — worth a look before filing.</div>
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-lg bg-sage/15 p-4 text-sm font-bold text-sage-ink">
              <CheckCircle className="h-4 w-4" />
              Signed off{readiness.signedOffAt ? ` ${new Date(readiness.signedOffAt).toLocaleDateString()}` : ''}. No changes since.
            </div>
          )
        ) : checklist.length === 0 ? (
          <div className="flex items-center gap-2 rounded-lg bg-sage/15 p-4 text-sm font-bold text-sage-ink">
            <CheckCircle className="h-4 w-4" />
            Nothing left to clean up for {monthLabel}.
          </div>
        ) : (
          <ul className="grid gap-1.5">
            {checklist.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => openItem(item)}
                  className="group flex min-h-12 w-full items-center gap-3 rounded-lg bg-[hsl(var(--color-sunken))] px-3 py-2 text-left transition-colors hover:bg-cream focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20"
                >
                  <span
                    className={cn(
                      'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                      item.severity === 'blocker' ? 'bg-coral/20 text-coral-ink' : item.severity === 'review' ? 'bg-lemon/40 text-lemon-ink dark:bg-lemon/15 dark:text-lemon' : 'bg-inverse text-inverse-foreground',
                    )}
                    aria-hidden="true"
                  >
                    {iconForCloseItem(item)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-bold text-ink">{item.label}</span>
                    <span className="block truncate text-xs text-dim">{item.detail}</span>
                  </span>
                  <span className="sr-only">{item.severity === 'blocker' ? 'Blocks sign-off.' : 'Review.'}</span>
                  <ExternalLink className="h-3.5 w-3.5 shrink-0 text-dim group-hover:text-ink" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </ReportCard>

      <ReportCard eyebrow="Accountant hand-off" title="Audit export">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-prose text-sm text-dim">
            {exportItem && exportItem.count > 0
              ? `An export for ${monthLabel} exists (${exportItem.label.replace(/^Export /, '')}).`
              : `CSV bundle of ${monthLabel}'s transactions, categories and receipts.`}
            {blockers > 0 && !readiness?.signedOff ? ' Best queued after the blockers above are cleared.' : ''}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => void queueExport()} disabled={busy !== null}>
              <Download className="h-3.5 w-3.5" />
              {exportItem && exportItem.count > 0 ? 'Queue again' : 'Queue export'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onViewChange?.({ view: 'settings', section: 'data' })}>
              Past exports
            </Button>
          </div>
        </div>
      </ReportCard>
    </div>
  );
}

function iconForCloseItem(item: CloseReadinessItem) {
  if (item.id.includes('receipt')) return <ReceiptIcon className="h-3.5 w-3.5" />;
  if (item.id.includes('categor') || item.id.includes('review')) return <Boxes className="h-3.5 w-3.5" />;
  if (item.id.includes('transfer') || item.id.includes('sync')) return <TriangleAlert className="h-3.5 w-3.5" />;
  return <CheckCircle className="h-3.5 w-3.5" />;
}
