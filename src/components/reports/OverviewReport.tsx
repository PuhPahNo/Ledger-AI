import { useEffect, useMemo, useRef, useState } from 'react';
import { getCashFlow, getOwnerInsights, listCategoryComparisons } from '@/api';
import type { CashFlowPeriod, CategoryComparison, Transaction } from '@/types/domain';
import { priorPeriod } from '@/lib/periods';
import { businessReportRows, reportPresets } from '@/lib/reports';
import { fmt$ } from '@/lib/format';
import { formatMonthLabel, parseLocalIsoDate, trailingMonthsFrom } from '@/lib/dates';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { DateRangePill } from '../transactions/TransactionPageParts';
import { CategoryBars } from '../home/CategoryBars';
import { BusinessTable } from './BusinessTable';
import { NetCashFlowChart, type CashFlowChartMode } from './NetCashFlowChart';
import { TagTrendsCard } from './TagTrendsCard';
import { ReportCard } from './ReportCard';
import type { ReportTabProps } from './reportTabs';

interface OverviewData {
  trend: CashFlowPeriod[];
  current: CashFlowPeriod[];
  prior: CashFlowPeriod[];
  categories: CategoryComparison[];
  topPurchases: Transaction[];
}

type SectionErrors = Partial<Record<'trend' | 'business' | 'categories' | 'purchases', string>>;

/**
 * Reports › Overview for one period: monthly net cash flow (trailing year, period
 * highlighted), by-business scorecard, category mix vs the prior period, top purchases, and
 * tag trends when any tag has spend.
 */
export function OverviewReport({ business, businesses, onOpenTransactions }: ReportTabProps) {
  const presets = useMemo(() => reportPresets(), []);
  const [range, setRange] = useState(() => ({ from: presets[0].from, to: presets[0].to }));
  const [mode, setMode] = useState<CashFlowChartMode>('net');
  const [data, setData] = useState<OverviewData | null>(null);
  const [errors, setErrors] = useState<SectionErrors>({});
  const [loading, setLoading] = useState(true);
  const requestSeq = useRef(0);

  const prior = useMemo(() => priorPeriod(range.from, range.to), [range.from, range.to]);
  const trendFrom = trailingMonthsFrom(range.to, 12);

  useEffect(() => {
    const requestId = ++requestSeq.current;
    setLoading(true);
    const failed = (result: PromiseSettledResult<unknown>) => (
      result.status === 'rejected' ? (result.reason instanceof Error ? result.reason.message : 'Could not load.') : undefined
    );
    Promise.allSettled([
      getCashFlow({ from: trendFrom, to: range.to, group: 'month', biz: business }),
      getCashFlow({ from: range.from, to: range.to, group: 'month', biz: business }),
      getCashFlow({ from: prior.from, to: prior.to, group: 'month', biz: business }),
      listCategoryComparisons({ from: range.from, to: range.to, prevFrom: prior.from, prevTo: prior.to, biz: business, limit: 20 }),
      getOwnerInsights({ from: range.from, to: range.to, biz: business }),
    ]).then(([trend, current, previous, categories, insights]) => {
      if (requestSeq.current !== requestId) return;
      setData({
        trend: trend.status === 'fulfilled' ? trend.value.periods : [],
        current: current.status === 'fulfilled' ? current.value.periods : [],
        prior: previous.status === 'fulfilled' ? previous.value.periods : [],
        categories: categories.status === 'fulfilled' ? categories.value : [],
        topPurchases: insights.status === 'fulfilled' ? insights.value.topPurchases : [],
      });
      setErrors({
        trend: failed(trend),
        business: failed(current) ?? failed(previous),
        categories: failed(categories),
        purchases: failed(insights),
      });
      setLoading(false);
    });
  }, [business, prior.from, prior.to, range.from, range.to, trendFrom]);

  const rows = useMemo(
    () => (data ? businessReportRows({ current: data.current, prior: data.prior, trend: data.trend }) : []),
    [data],
  );
  const compareLabel = priorLabel(prior);
  const scope = business === 'all' ? undefined : business;
  const businessById = new Map(businesses.map((item) => [item.id, item]));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <DateRangePill from={range.from} to={range.to} presets={presets} onChange={(next) => next.from && next.to && next.from <= next.to && setRange(next)} />
        <span className="text-xs text-dim">compared with {compareLabel}</span>
      </div>

      {!data ? (
        <div className="grid gap-3" aria-hidden="true">
          <Skeleton className="h-72" />
          <Skeleton className="h-48" />
        </div>
      ) : (
        <div className={loading ? 'flex flex-col gap-3 opacity-60 transition-opacity' : 'flex flex-col gap-3 transition-opacity'} aria-busy={loading}>
          <ReportCard
            eyebrow="Cash flow · 12 months"
            title={mode === 'net' ? 'Net cash flow by month' : 'Money in vs out by month'}
            action={(
              <ToggleGroup type="single" size="sm" value={mode} aria-label="Chart" onValueChange={(value) => value && setMode(value as CashFlowChartMode)}>
                <ToggleGroupItem value="net">Net</ToggleGroupItem>
                <ToggleGroupItem value="flow">In vs out</ToggleGroupItem>
              </ToggleGroup>
            )}
            error={errors.trend}
          >
            <NetCashFlowChart periods={data.trend} mode={mode} highlight={range} />
          </ReportCard>

          <ReportCard eyebrow="By business" title="Scorecard" error={errors.business}>
            <BusinessTable rows={rows} compareLabel="prior" />
          </ReportCard>

          <div className="grid gap-3 xl:grid-cols-2">
            <ReportCard eyebrow="Categories" title="Category mix" error={errors.categories}>
              <CategoryBars
                rows={data.categories}
                compareLabel={compareLabel}
                onSelect={(category) => onOpenTransactions?.({ business: scope, categories: [category], from: range.from, to: range.to, direction: 'operating-outflow' })}
              />
            </ReportCard>
            <ReportCard eyebrow="Largest outflows" title="Top purchases" error={errors.purchases}>
              {data.topPurchases.length === 0 ? (
                <div className="py-6 text-center text-sm text-dim">No outflows in this period.</div>
              ) : (
                <ol className="grid gap-0.5">
                  {data.topPurchases.slice(0, 8).map((purchase) => {
                    const biz = businessById.get(purchase.biz);
                    return (
                      <li key={purchase.id}>
                        <button
                          type="button"
                          onClick={() => onOpenTransactions?.({ business: purchase.biz, query: purchase.merchant, from: range.from, to: range.to })}
                          className="flex min-h-10 w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-cream/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20"
                        >
                          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: biz?.color ?? 'hsl(var(--color-dim))' }} aria-hidden="true" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-bold text-ink">{purchase.merchant}</span>
                            <span className="block truncate text-[11px] text-dim">
                              {purchase.dateLabel || purchase.date} · {biz?.short ?? purchase.biz} · {purchase.cat}
                            </span>
                          </span>
                          <span className="font-display text-sm font-bold tabular-nums">{fmt$(Math.abs(purchase.amount))}</span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
              )}
            </ReportCard>
          </div>

          <TagTrendsCard from={trendFrom} to={range.to} period={range} />
        </div>
      )}
    </div>
  );
}

/** "August 2026", "Jun – Aug 2026", or the raw dates for ranges that aren't month-aligned. */
function priorLabel(range: { from: string; to: string }): string {
  const start = parseLocalIsoDate(range.from);
  const end = parseLocalIsoDate(range.to);
  const endIsMonthEnd = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1).getDate() === 1;
  if (start.getDate() === 1 && range.from.slice(0, 7) === range.to.slice(0, 7)) {
    return endIsMonthEnd
      ? formatMonthLabel(range.from.slice(0, 7))
      : `${start.toLocaleDateString('en-US', { month: 'short' })} 1–${end.getDate()}, ${start.getFullYear()}`;
  }
  const fmt = (date: Date) => date.toLocaleDateString('en-US', { month: 'short', day: start.getDate() === 1 && endIsMonthEnd ? undefined : 'numeric', year: 'numeric' });
  return `${fmt(start)} – ${fmt(end)}`;
}
