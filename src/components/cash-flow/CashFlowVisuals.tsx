import { ChevronDown, ChevronUp, TrendingDown, TrendingUp } from 'lucide-react';
import type { CashFlowPeriod, Category } from '@/types/domain';
import { Card } from '@/components/ui/card';
import { useResolvedColor } from '@/hooks/useTheme';
import { cn } from '@/lib/cn';

export interface ComparisonCardData {
  label: string;
  sub: string;
  inflowCents: number;
  outflowCents: number;
  netCents: number;
  current: boolean;
  moDelta?: number;
  yoyDelta?: number;
}

export function ComparisonCard({ data }: { data: ComparisonCardData }) {
  const current = data.current;
  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border shadow-sm',
        current ? 'border-ink2/30 bg-strong text-strong-foreground' : 'border-ink2/10 bg-paper',
      )}
    >
      <div className={cn('px-4 py-3', current ? 'border-b border-strong-foreground/15' : 'border-b border-ink2/10')}>
        <div className={cn('font-mono text-[10px] uppercase tracking-wider', current ? 'text-strong-foreground/60' : 'text-dim')}>
          {data.label}
        </div>
        <div
          className={cn(
            'font-display text-2xl font-bold tabular-nums',
            data.netCents < 0 && !current && 'text-coral-ink',
          )}
        >
          {fmtCompactCents(data.netCents, { signed: true })}
        </div>
        <div className={cn('text-xs', current ? 'text-strong-foreground/60' : 'text-dim')}>{data.sub}</div>
      </div>
      <div className={cn('grid grid-cols-2 divide-x', current ? 'divide-strong-foreground/15' : 'divide-ink2/10')}>
        <div className="px-4 py-3">
          <div className={cn('font-mono text-[10px] uppercase tracking-wider', current ? 'text-strong-foreground/60' : 'text-dim')}>
            Inflow
          </div>
          <div className={cn('font-bold tabular-nums', current ? 'text-strong-foreground' : 'text-sage-ink')}>
            +{fmtCompactCents(data.inflowCents)}
          </div>
        </div>
        <div className="px-4 py-3">
          <div className={cn('font-mono text-[10px] uppercase tracking-wider', current ? 'text-strong-foreground/60' : 'text-dim')}>
            Outflow
          </div>
          <div className={cn('font-bold tabular-nums', current ? 'text-strong-foreground' : 'text-ink')}>
            -{fmtCompactCents(data.outflowCents)}
          </div>
        </div>
      </div>
      {current && (
        <div className="grid grid-cols-2 divide-x divide-strong-foreground/15 border-t border-strong-foreground/15">
          <div className="px-4 py-3">
            <div className="font-mono text-[10px] uppercase tracking-wider text-strong-foreground/60">vs Last month</div>
            <DeltaPct value={data.moDelta ?? 0} />
          </div>
          <div className="px-4 py-3">
            <div className="font-mono text-[10px] uppercase tracking-wider text-strong-foreground/60">vs Last year</div>
            <DeltaPct value={data.yoyDelta ?? 0} />
          </div>
        </div>
      )}
    </div>
  );
}

export function ChartLegend({ periods }: { periods: CashFlowPeriod[] }) {
  const colors = new Map<string, { name: string; color: string }>();
  periods.forEach((period) => {
    period.businessBreakdown.forEach((row) => {
      if (!colors.has(row.businessId)) {
        colors.set(row.businessId, { name: row.businessName, color: row.color });
      }
    });
  });
  if (colors.size === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs font-medium text-dim">
      {[...colors.values()].map((entry) => (
        <span key={entry.name} className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: entry.color }} />
          {entry.name}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <span className="h-px w-4 bg-ink" />
        Net
      </span>
    </div>
  );
}

export function CashFlowChart({ periods, height = 260 }: { periods: CashFlowPeriod[]; height?: number }) {
  if (periods.length === 0) {
    return (
      <div className="flex items-center justify-center text-sm text-dim" style={{ height }}>
        No periods to chart.
      </div>
    );
  }

  const max = Math.max(...periods.map((p) => Math.max(p.outflowCents, p.inflowCents)), 1);
  const netMax = Math.max(...periods.map((p) => Math.abs(p.netCents)), 1);
  const chartArea = height - 24;
  const half = chartArea / 2;

  return (
    <div className="relative w-full" style={{ height }}>
      <div className="pointer-events-none absolute inset-x-0" style={{ top: 0, height: chartArea }}>
        {[0, 0.25, 0.5, 0.75, 1].map((position) => (
          <div
            key={position}
            className="absolute inset-x-0 border-t border-ink2/5"
            style={{ top: `${position * 100}%` }}
          />
        ))}
        <div className="absolute inset-x-0 border-t border-ink2/20" style={{ top: '50%' }} />
      </div>

      <div className="absolute inset-x-0 flex" style={{ top: 0, height: chartArea }}>
        {periods.map((period) => (
          <div key={period.label} className="relative flex flex-1 items-center justify-center">
            <div
              className="absolute flex w-[60%] max-w-[40px] flex-col-reverse overflow-hidden rounded-sm"
              style={{ bottom: '50%', height: `${(period.inflowCents / max) * half}px` }}
            >
              {period.businessBreakdown.map((row) => {
                const portion = period.inflowCents ? row.inflowCents / period.inflowCents : 0;
                if (!row.inflowCents) return null;
                return (
                  <div
                    key={`in-${row.businessId}`}
                    style={{ height: `${portion * 100}%`, background: row.color, opacity: 0.6 }}
                  />
                );
              })}
            </div>
            <div
              className="absolute flex w-[60%] max-w-[40px] flex-col overflow-hidden rounded-sm"
              style={{ top: '50%', height: `${(period.outflowCents / max) * half}px` }}
            >
              {period.businessBreakdown.map((row) => {
                const portion = period.outflowCents ? row.outflowCents / period.outflowCents : 0;
                if (!row.outflowCents) return null;
                return (
                  <div
                    key={`out-${row.businessId}`}
                    style={{ height: `${portion * 100}%`, background: row.color, opacity: 0.9 }}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <NetLineOverlay periods={periods} netMax={netMax} height={chartArea} half={half} />

      <div className="absolute inset-x-0 bottom-0 flex">
        {periods.map((period) => (
          <div
            key={period.label}
            className="flex-1 text-center font-mono text-[10px] font-medium uppercase tracking-wider text-dim"
          >
            {period.label}
          </div>
        ))}
      </div>
    </div>
  );
}

export function CategoryMixCard({ categories, period }: { categories: Category[]; period: CashFlowPeriod | null }) {
  const palette = ['#D97757', '#2A6FDB', '#1F8A5B', '#caa6f0', '#f1b6c5', '#ecd95a', '#9fc6e8', '#abc89a'];
  return (
    <Card className="p-4">
      <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">
        Category mix{period ? ` · ${period.label}` : ''}
      </div>
      <h3 className="mb-3 font-display text-lg font-bold text-ink">Where outflow went</h3>
      {categories.length === 0 ? (
        <div className="py-8 text-center text-sm text-dim">No spend categorized yet.</div>
      ) : (
        <div className="flex flex-col gap-2">
          {categories.map((category, index) => {
            const max = categories[0].amountCents ?? Math.round(categories[0].amount * 100);
            const cents = category.amountCents ?? Math.round(category.amount * 100);
            const width = max ? (cents / max) * 100 : 0;
            return (
              <div key={`${category.name}-${index}`} className="grid grid-cols-[120px_1fr_88px] items-center gap-3">
                <span className="truncate text-xs font-bold text-ink">{category.name}</span>
                <div className="h-3 overflow-hidden rounded-full bg-[hsl(var(--color-sunken))]">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${width}%`, background: palette[index % palette.length] }}
                  />
                </div>
                <div className="text-right">
                  <div className="font-display text-sm font-bold tabular-nums">{fmtCompactCents(cents)}</div>
                  <Delta label={category.delta} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

export function BusinessBreakdown({ periods }: { periods: CashFlowPeriod[] }) {
  const latest = periods.at(-1);
  if (!latest || latest.businessBreakdown.length === 0) {
    return <div className="py-6 text-center text-sm text-dim">No business breakdown.</div>;
  }
  const sorted = [...latest.businessBreakdown].sort((a, b) => b.netCents - a.netCents);
  return (
    <div className="flex flex-col gap-2">
      {sorted.map((row) => {
        const positive = row.netCents >= 0;
        return (
          <div key={row.businessId} className="flex items-center gap-3 rounded-lg bg-[hsl(var(--color-sunken))] p-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg" style={{ background: `${row.color}22` }}>
              {positive ? (
                <TrendingUp className="h-4 w-4" style={{ color: row.color }} />
              ) : (
                <TrendingDown className="h-4 w-4" style={{ color: row.color }} />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-bold text-ink">{row.businessName}</div>
              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-dim">
                <span className="text-sage-ink">+{fmtCompactCents(row.inflowCents)}</span>
                <span>·</span>
                <span>-{fmtCompactCents(row.outflowCents)}</span>
              </div>
            </div>
            <div className="text-right">
              <div
                className={cn(
                  'font-display text-sm font-bold tabular-nums',
                  positive ? 'text-sage-ink' : 'text-coral-ink',
                )}
              >
                {fmtCompactCents(row.netCents, { signed: true })}
              </div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-dim">Net</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function NetLineOverlay({
  periods,
  netMax,
  height,
  half,
}: {
  periods: CashFlowPeriod[];
  netMax: number;
  height: number;
  half: number;
}) {
  const netLine = useResolvedColor('--color-ink', 'hsl(45 14% 7%)');
  if (periods.length < 2) return null;
  const points = periods.map((period, index) => {
    const x = ((index + 0.5) / periods.length) * 100;
    const offset = (period.netCents / netMax) * (half * 0.85);
    const yPx = half - offset;
    const yPct = (yPx / height) * 100;
    return { x, y: yPct };
  });
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
  return (
    <div className="pointer-events-none absolute inset-x-0" style={{ top: 0, height }}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
        <path
          d={path}
          fill="none"
          stroke={netLine}
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
      {points.map((p, i) => (
        <div
          key={i}
          className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] border-ink bg-paper"
          style={{ left: `${p.x}%`, top: `${p.y}%` }}
        />
      ))}
    </div>
  );
}

function DeltaPct({ value }: { value: number }) {
  const positive = value >= 0;
  const Icon = positive ? ChevronUp : ChevronDown;
  return (
    <span className={cn('inline-flex items-center gap-1 font-bold tabular-nums', positive ? 'text-sage' : 'text-coral')}>
      <Icon className="h-3.5 w-3.5" />
      {value}%
    </span>
  );
}

function Delta({ label }: { label?: string }) {
  if (!label) return null;
  const positive = !label.startsWith('-');
  const Icon = positive ? ChevronUp : ChevronDown;
  return (
    <span
      className={cn(
        'inline-flex items-center justify-end gap-1 font-bold tabular-nums text-[10px]',
        positive ? 'text-sage-ink' : 'text-coral-ink',
      )}
    >
      <Icon className="h-3 w-3" />
      {label.replace(/^[+-]/, '')}
    </span>
  );
}

export function fmtCompactCents(cents: number, options: { signed?: boolean } = {}): string {
  const amount = cents / 100;
  const absAmount = Math.abs(amount);
  const sign = options.signed ? (amount >= 0 ? '+' : '-') : amount < 0 ? '-' : '';
  if (absAmount >= 1000) {
    return `${sign}$${new Intl.NumberFormat('en-US', {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(absAmount)}`;
  }
  return `${sign}$${absAmount.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

export function prevYearLabel(label: string): string {
  const match = label.match(/^(\w+) ?(\d{2,4})?$/);
  if (!match) return label;
  const month = match[1];
  const year = match[2];
  if (!year) return `${month} (prior year)`;
  const fullYear = year.length === 2 ? 2000 + Number(year) : Number(year);
  return `${month} ${String(fullYear - 1).slice(-2)}`;
}
