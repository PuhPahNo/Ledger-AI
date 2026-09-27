import { useEffect, useMemo, useState } from 'react';
import type { Business, Category, Transaction } from '@/types/domain';
import { listTransactions, type SummaryBreakdowns } from '@/api';
import { accentRamp } from '@/theme/tokens';
import { fmt$k } from '@/lib/format';
import { Tile } from '@/components/ui/tile';
import { StatLabel } from '@/components/ui/stat-label';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ChartTooltip, useChartTooltip } from '@/components/ui/chart-tooltip';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

// Category and account breakdowns live in their own tiles (Categories donut, Spend by
// account) — this tile only carries the views that aren't shown elsewhere.
type Mode = 'business' | 'purchase' | 'receipt';

export interface AnalysisFilters {
  from: string;
  to: string;
  business: string;
  accountIds: string[];
  query?: string;
}

interface Props {
  businesses: Business[];
  categories: Category[];
  breakdowns: SummaryBreakdowns;
  filters: AnalysisFilters;
  onOpenTransactions: () => void;
}

interface AnalysisTipData {
  label: string;
  amount: number;
  count: number;
  share: number;
}

interface Row {
  key: string;
  label: string;
  amount: number;
  count: number;
  color?: string;
}

export function AnalysisTile({ businesses, categories, breakdowns, filters, onOpenTransactions }: Props) {
  const [mode, setMode] = useState<Mode>('business');
  const [purchaseBusinessId, setPurchaseBusinessId] = useState<string | null>(null);
  const [purchaseCategory, setPurchaseCategory] = useState<string | null>(null);
  const [purchaseRows, setPurchaseRows] = useState<Transaction[]>([]);
  const [purchaseLoading, setPurchaseLoading] = useState(false);

  const rows = useMemo<Row[]>(() => {
    const buckets = mode === 'receipt' ? breakdowns.byReceipt : breakdowns.byBusiness;
    return buckets.map((bucket) => ({
      key: bucket.key,
      label: bucket.label,
      amount: bucket.cents / 100,
      count: bucket.count,
      color: mode === 'business' ? bucket.color : undefined,
    }));
  }, [breakdowns, mode]);

  const categoryOptions = useMemo(
    () => categories.filter((category) => category.amount > 0).map((category) => category.name),
    [categories],
  );
  // Defaults come from the data: the business and category with the most spend in view.
  const businessOptions = filters.business === 'all'
    ? businesses
    : businesses.filter((business) => business.id === filters.business);
  const activeBusinessId = purchaseBusinessId && businessOptions.some((business) => business.id === purchaseBusinessId)
    ? purchaseBusinessId
    : breakdowns.byBusiness.find((bucket) => businessOptions.some((business) => business.id === bucket.key))?.key
      ?? businessOptions[0]?.id
      ?? '';
  const activeCategory = purchaseCategory && categoryOptions.includes(purchaseCategory)
    ? purchaseCategory
    : categoryOptions[0] ?? '';

  const accountKey = filters.accountIds.join(',');
  useEffect(() => {
    if (mode !== 'purchase' || !activeBusinessId || !activeCategory) {
      setPurchaseRows([]);
      return;
    }
    let cancelled = false;
    setPurchaseLoading(true);
    listTransactions({
      biz: activeBusinessId,
      categories: [activeCategory],
      direction: 'operating-outflow',
      accountIds: filters.accountIds,
      q: filters.query || undefined,
      from: filters.from,
      to: filters.to,
      sort: 'largest',
      dir: 'desc',
      limit: 6,
    })
      .then((result) => !cancelled && setPurchaseRows(result))
      .catch(() => !cancelled && setPurchaseRows([]))
      .finally(() => !cancelled && setPurchaseLoading(false));
    return () => {
      cancelled = true;
    };
  }, [accountKey, activeBusinessId, activeCategory, filters.from, filters.query, filters.to, mode]);

  const max = Math.max(
    ...(mode === 'purchase' ? purchaseRows.map((row) => Math.abs(row.amount)) : rows.map((row) => row.amount)),
    1,
  );
  const total = breakdowns.spendCents / 100;
  const purchaseTotal = purchaseRows.reduce((sum, row) => sum + Math.abs(row.amount), 0);
  const { tip, containerRef, show, hide } = useChartTooltip<AnalysisTipData>();

  return (
    <Tile tone="paper" pad="md" colSpan={6} rowSpan={2} className="gap-3">
      <div className="flex items-baseline gap-3">
        <div>
          <StatLabel className="text-dim opacity-100">ANALYSIS</StatLabel>
          <div className="mt-0.5 font-display text-xl font-bold">Breakdowns</div>
        </div>
        <span className="flex-1" />
        <Button variant="outline" size="sm" onClick={onOpenTransactions}>
          View all
        </Button>
      </div>

      <Tabs value={mode} onValueChange={(value) => setMode(value as Mode)}>
        <TabsList className="h-8 self-start bg-[hsl(var(--color-sunken))]">
          <TabsTrigger value="business" className="h-7 text-[11px]">Business</TabsTrigger>
          <TabsTrigger value="purchase" className="h-7 text-[11px]">Top purchases</TabsTrigger>
          <TabsTrigger value="receipt" className="h-7 text-[11px]">Receipts</TabsTrigger>
        </TabsList>
      </Tabs>

      {mode === 'purchase' && (
        <div className="grid grid-cols-2 gap-2">
          <Select value={activeBusinessId || undefined} onValueChange={setPurchaseBusinessId}>
            <SelectTrigger className="h-8 rounded-md bg-paper px-2 text-xs">
              <SelectValue placeholder="Business" />
            </SelectTrigger>
            <SelectContent>
              {businessOptions.map((business) => (
                <SelectItem key={business.id} value={business.id}>{business.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={activeCategory || undefined} onValueChange={setPurchaseCategory}>
            <SelectTrigger className="h-8 rounded-md bg-paper px-2 text-xs">
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>
              {categoryOptions.map((category) => (
                <SelectItem key={category} value={category}>{category}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div ref={containerRef} className="relative grid min-h-0 gap-2.5 overflow-auto" onMouseLeave={hide}>
        {mode === 'purchase' ? purchaseRows.map((transaction, index) => {
          const amount = Math.abs(transaction.amount);
          const data: AnalysisTipData = {
            label: transaction.merchant,
            amount,
            count: 1,
            share: purchaseTotal > 0 ? (amount / purchaseTotal) * 100 : 0,
          };
          return (
            <BarRow
              key={transaction.id}
              label={transaction.merchant}
              meta={transaction.dateLabel}
              amount={amount}
              width={(amount / max) * 100}
              color={businesses.find((business) => business.id === transaction.biz)?.color ?? accentRamp[index % accentRamp.length]}
              onHover={(event) => show(data, event)}
            />
          );
        }) : rows.slice(0, 6).map((row, index) => {
          const data: AnalysisTipData = {
            label: row.label,
            amount: row.amount,
            count: row.count,
            share: total > 0 ? (row.amount / total) * 100 : 0,
          };
          return (
            <BarRow
              key={row.key}
              label={row.label}
              meta={String(row.count)}
              amount={row.amount}
              width={(row.amount / max) * 100}
              color={row.color ?? accentRamp[index % accentRamp.length]}
              onHover={(event) => show(data, event)}
            />
          );
        })}
        {mode !== 'purchase' && !rows.length && <div className="text-sm text-dim">No spend matches the current filters.</div>}
        {mode === 'purchase' && !purchaseLoading && !purchaseRows.length && (
          <div className="text-sm text-dim">No purchases match the current filters.</div>
        )}
        <ChartTooltip open={tip.open} x={tip.x} y={tip.y}>
          {tip.data && (
            <>
              <div className="font-bold uppercase tracking-wider text-[10px] opacity-70">{tip.data.label}</div>
              <div className="font-display font-bold tabular-nums">{fmt$k(tip.data.amount)}</div>
              <div className="text-[10px] opacity-70">
                {tip.data.count} {tip.data.count === 1 ? 'txn' : 'txns'} · {tip.data.share.toFixed(1)}% of {mode === 'purchase' ? 'shown' : 'spend'}
              </div>
            </>
          )}
        </ChartTooltip>
      </div>
    </Tile>
  );
}

function BarRow({
  label,
  meta,
  amount,
  width,
  color,
  onHover,
}: {
  label: string;
  meta?: string;
  amount: number;
  width: number;
  color: string;
  onHover: (event: React.MouseEvent) => void;
}) {
  return (
    <div
      className="grid gap-1 rounded-md px-1 py-0.5 transition-colors hover:bg-cream/60"
      onMouseEnter={onHover}
      onMouseMove={onHover}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-bold">{label}</span>
        {meta && <span className="shrink-0 text-xs text-dim">{meta}</span>}
        <span className="shrink-0 font-display text-sm font-bold tabular-nums">{fmt$k(amount)}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-[hsl(var(--color-sunken))]">
        <div className="h-full rounded-full" style={{ width: `${Math.max(4, width)}%`, background: color }} />
      </div>
    </div>
  );
}
