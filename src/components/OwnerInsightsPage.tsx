import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowUpRight,
  Boxes,
  Check,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Download,
  Receipt as ReceiptIcon,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import {
  getCashFlow,
  getOwnerInsights,
  listBusinesses,
  listCategories,
  uploadReceipt,
} from '@/api';
import type {
  Business,
  CashFlowSummary,
  Category,
  CurrentUser,
  OwnerInsightsSummary,
} from '@/types/domain';
import type { AppView } from '@/types/navigation';
import { fmt$ } from '@/lib/format';
import { useToast } from '@/hooks/useToast';
import { useResolvedColor } from '@/hooks/useTheme';
import { AppShell } from './AppShell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/cn';

interface Props {
  user?: CurrentUser;
  onViewChange?: (view: AppView) => void;
  onLogout?: () => void;
}

const emptyInsights: OwnerInsightsSummary = {
  from: '',
  to: '',
  topPurchases: [],
  uncategorized: { count: 0, cents: 0 },
  missingReceipts: { count: 0, cents: 0 },
  transfers: { count: 0, cents: 0 },
  incomeByBusiness: [],
  closeSummary: { inflowCents: 0, outflowCents: 0, netCents: 0, transactionCount: 0 },
};

const emptyCashFlow: CashFlowSummary = {
  from: '',
  to: '',
  group: 'month',
  includeTransfers: false,
  totals: {
    inflowCents: 0,
    outflowCents: 0,
    transferCents: 0,
    netCents: 0,
    previousInflowCents: 0,
    previousOutflowCents: 0,
    previousTransferCents: 0,
    previousNetCents: 0,
    netDeltaCents: 0,
    netDeltaPct: 0,
  },
  periods: [],
};

export function OwnerInsightsPage({ user, onViewChange, onLogout }: Props) {
  const { toast } = useToast();
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [summary, setSummary] = useState<OwnerInsightsSummary>(emptyInsights);
  const [cashFlow, setCashFlow] = useState<CashFlowSummary>(emptyCashFlow);
  const [categories, setCategories] = useState<Category[]>([]);
  const [business, setBusiness] = useState('all');
  const [from, setFrom] = useState(startOfMonth());
  const [to, setTo] = useState(today());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    listBusinesses()
      .then(setBusinesses)
      .catch((loadError: Error) => setError(loadError.message));
  }, []);

  useEffect(() => {
    setLoading(true);
    setError('');
    Promise.all([
      getOwnerInsights({ from, to, biz: business }),
      getCashFlow({
        from: trailing12From(to),
        to,
        group: 'month',
        biz: business,
      }),
      listCategories({ from, to, biz: business }),
    ])
      .then(([insightsResult, cashFlowResult, categoryRows]) => {
        setSummary(insightsResult);
        setCashFlow(cashFlowResult);
        setCategories(categoryRows);
      })
      .catch((loadError: Error) => setError(loadError.message))
      .finally(() => setLoading(false));
  }, [business, from, refreshKey, to]);

  const selectedBusinessDbId = business === 'all' ? undefined : businesses.find((item) => item.id === business)?.dbId;

  const handleUpload = async (file: File) => {
    try {
      await uploadReceipt(file, selectedBusinessDbId);
      toast({ variant: 'success', title: 'Receipt queued' });
      setRefreshKey((key) => key + 1);
    } catch (uploadError) {
      toast({
        variant: 'destructive',
        title: 'Upload failed',
        description: uploadError instanceof Error ? uploadError.message : 'Try again.',
      });
    }
  };

  const briefing = useMemo(() => buildBriefing(summary, cashFlow, categories), [summary, cashFlow, categories]);
  const briefDate = useMemo(() => {
    const date = new Date(`${to}T00:00:00`);
    return {
      tag: date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' }),
      monthLabel: date.toLocaleDateString('en-US', { month: 'long' }),
    };
  }, [to]);

  return (
    <AppShell
      currentView="insights"
      onViewChange={onViewChange}
      onLogout={onLogout}
      user={user}
      onUploadReceipt={handleUpload}
      contextEyebrow="Owner brief"
      contextTitle="Insights"
      businesses={businesses}
      selectedBusiness={business}
      onBusinessChange={setBusiness}
      contextActions={
        <Button variant="outline" size="sm" onClick={() => exportInsightsCsv(summary)}>
          <Download className="h-3.5 w-3.5" />
          Export
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {error && (
          <div className="rounded-xl border border-coral/30 bg-coral/10 p-4 text-sm font-bold text-coral-ink">{error}</div>
        )}

        {/* Date selector */}
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-ink2/10 bg-paper px-3 py-2 shadow-sm">
          <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-dim">Period</span>
          <input
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            className="h-8 rounded-md border border-ink2/10 bg-paper px-2 text-xs"
          />
          <span className="text-dim">→</span>
          <input
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            className="h-8 rounded-md border border-ink2/10 bg-paper px-2 text-xs"
          />
        </div>

        {/* HERO: magazine-style headline + AI narrative + KPI sidecards */}
        <div className="grid gap-3 lg:grid-cols-[1.5fr_1fr]">
          <div className="overflow-hidden rounded-2xl border border-ink2/10 bg-strong p-7 text-strong-foreground shadow-md">
            <div className="flex items-center gap-3">
              <span className="rounded-full bg-strong-foreground/10 px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-strong-foreground/80">
                {briefDate.tag}
              </span>
              <span className="font-mono text-[10px] uppercase tracking-wider text-strong-foreground/60">Morning brief</span>
            </div>
            <h1 className="mt-4 font-display text-4xl font-bold leading-[1.05] tracking-tight">
              {briefing.headlinePrefix}{' '}
              <span className={briefing.headlineAccentTone === 'positive' ? 'text-lemon' : 'text-coral'}>
                {briefing.headlineAccent}
              </span>
              {briefing.headlineSuffix && (
                <> — <span className="text-strong-foreground/70">{briefing.headlineSuffix}</span></>
              )}
            </h1>
            <div className="mt-5 flex items-start gap-3 rounded-xl bg-strong-foreground/5 p-4">
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-lemon" />
              <div className="flex-1 text-sm leading-relaxed text-strong-foreground/85">{briefing.narrative}</div>
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <Button
                variant="accent"
                size="sm"
                onClick={() => onViewChange?.('transactions')}
              >
                <Check className="h-3.5 w-3.5" />
                Review transactions
              </Button>
              <button
                type="button"
                onClick={() => onViewChange?.('cash-flow')}
                className="inline-flex items-center gap-1.5 rounded-full border border-strong-foreground/20 px-3 py-1.5 text-xs font-bold text-strong-foreground hover:bg-strong-foreground/10"
              >
                <ChevronRight className="h-3 w-3" />
                Open cash flow
              </button>
            </div>
          </div>

          <div className="grid gap-3">
            <Card className="bg-cream p-4">
              <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">
                Net cash · {briefDate.monthLabel}
              </div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="font-display text-3xl font-bold tabular-nums text-ink">
                  {fmt$(summary.closeSummary.netCents / 100)}
                </span>
                <Delta value={briefing.netYoYDelta} />
              </div>
              <div className="mt-2 text-xs text-dim">
                vs {fmt$(briefing.previousNetCents / 100)} last year
              </div>
              <div className="mt-3 h-12">
                <Sparkline values={briefing.netSpark} positive />
              </div>
            </Card>
            <div className="grid grid-cols-2 gap-3">
              <Card className="p-3">
                <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">Inflow</div>
                <div className="mt-1 font-display text-xl font-bold tabular-nums text-sage-ink">
                  {fmt$(summary.closeSummary.inflowCents / 100)}
                </div>
                <Delta value={briefing.inflowDelta} />
              </Card>
              <Card className="p-3">
                <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">Outflow</div>
                <div className="mt-1 font-display text-xl font-bold tabular-nums text-ink">
                  {fmt$(summary.closeSummary.outflowCents / 100)}
                </div>
                <Delta value={briefing.outflowDelta} invertColors />
              </Card>
            </div>
          </div>
        </div>

        {/* Story cards built from real signals */}
        {briefing.stories.length > 0 && (
          <div className="grid gap-3 lg:grid-cols-3">
            {briefing.stories.map((story, index) => {
              const tones = {
                lemon: { bg: 'bg-lemon/30', tag: 'bg-lemon-ink/10 text-lemon-ink', stat: 'text-lemon-ink' },
                coral: { bg: 'bg-coral/20', tag: 'bg-coral-ink/10 text-coral-ink', stat: 'text-coral-ink' },
                sage: { bg: 'bg-sage/25', tag: 'bg-sage-ink/10 text-sage-ink', stat: 'text-sage-ink' },
              }[story.tone];
              return (
                <div
                  key={index}
                  className={cn(
                    'flex flex-col rounded-2xl border border-ink2/10 p-5 shadow-sm transition-shadow hover:shadow-md',
                    tones.bg,
                  )}
                >
                  <div
                    className={cn(
                      'inline-flex w-fit items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider',
                      tones.tag,
                    )}
                  >
                    {story.tag}
                  </div>
                  <h3 className="mt-3 font-display text-xl font-bold leading-tight text-ink">{story.head}</h3>
                  <p className="mt-2 text-sm text-ink/70">{story.body}</p>
                  <div className="mt-4 flex items-end justify-between border-t border-ink2/10 pt-3">
                    <div>
                      <div className="font-mono text-[9px] uppercase tracking-wider text-dim">{story.statLabel}</div>
                      <div className={cn('font-display text-xl font-bold tabular-nums', tones.stat)}>
                        {story.stat}
                      </div>
                    </div>
                    <ArrowUpRight className="h-4 w-4 text-dim" />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Period scorecard: by business, with sparklines */}
        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">
                Period scorecard
              </div>
              <h3 className="font-display text-xl font-bold text-ink">By business, vs prior period</h3>
            </div>
          </div>
          <BusinessScorecard cashFlow={cashFlow} insights={summary} />
        </Card>

        {/* Bottom: top purchases + close queue */}
        <div className="grid gap-3 lg:grid-cols-[1.4fr_1fr]">
          <Card className="p-4">
            <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">
              Largest outflows
            </div>
            <h3 className="mb-3 font-display text-lg font-bold text-ink">Top purchases this period</h3>
            {summary.topPurchases.length === 0 ? (
              <div className="py-6 text-center text-sm text-dim">No outflows in this period.</div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {summary.topPurchases.slice(0, 6).map((purchase, index) => {
                  const biz = businesses.find((item) => item.id === purchase.biz);
                  return (
                    <div
                      key={purchase.id}
                      className="grid grid-cols-[24px_1fr_120px_100px] items-center gap-3 rounded-lg px-3 py-2 hover:bg-cream/40"
                    >
                      <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-dim">
                        #{index + 1}
                      </span>
                      <div className="min-w-0">
                        <div className="truncate font-bold text-ink">{purchase.merchant}</div>
                        <div className="text-[11px] text-dim">{purchase.cat} · {purchase.dateLabel || purchase.date}</div>
                      </div>
                      <span className="inline-flex items-center gap-1.5 text-xs">
                        <span
                          className="h-1.5 w-1.5 rounded-full"
                          style={{ background: biz?.color ?? '#ccc' }}
                        />
                        <span className="truncate text-dim">{biz?.name ?? purchase.biz}</span>
                      </span>
                      <span className="text-right font-display font-bold tabular-nums">
                        {fmt$(Math.abs(purchase.amount))}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">
                  Close queue
                </div>
                <h3 className="font-display text-lg font-bold text-ink">{briefing.closeItems.length} items left</h3>
              </div>
              {briefing.closeItems.length > 0 && (
                <Button size="sm" onClick={() => onViewChange?.('transactions')}>
                  Start close
                </Button>
              )}
            </div>
            {briefing.closeItems.length === 0 ? (
              <div className="rounded-lg bg-sage/15 p-4 text-sm font-bold text-sage-ink">
                <CheckCircle className="mb-2 inline h-4 w-4" /> Everything is clean for this period.
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {briefing.closeItems.map((item, index) => (
                  <button
                    key={index}
                    type="button"
                    onClick={item.onClick}
                    className="group flex items-center gap-3 rounded-lg bg-[hsl(var(--color-sunken))] px-3 py-2 text-left transition-colors hover:bg-cream"
                  >
                    <span
                      className={cn(
                        'flex h-7 w-7 items-center justify-center rounded-lg',
                        item.tone === 'warn' ? 'bg-coral/20 text-coral-ink' : 'bg-inverse text-inverse-foreground',
                      )}
                    >
                      {item.icon}
                    </span>
                    <span className="flex-1 text-sm font-bold text-ink">{item.label}</span>
                    <ChevronRight className="h-3.5 w-3.5 text-dim group-hover:text-ink" />
                  </button>
                ))}
              </div>
            )}
          </Card>
        </div>

        {loading && (
          <div className="rounded-xl border border-ink2/10 bg-paper p-6 text-center text-sm text-dim">Refreshing…</div>
        )}
      </div>
    </AppShell>
  );
}

interface Briefing {
  headlinePrefix: string;
  headlineAccent: string;
  headlineAccentTone: 'positive' | 'warning';
  headlineSuffix?: string;
  narrative: string;
  netYoYDelta: number;
  previousNetCents: number;
  netSpark: number[];
  inflowDelta: number;
  outflowDelta: number;
  stories: BriefingStory[];
  closeItems: CloseItem[];
}

interface BriefingStory {
  tag: string;
  tone: 'lemon' | 'coral' | 'sage';
  head: string;
  body: string;
  stat: string;
  statLabel: string;
}

interface CloseItem {
  label: string;
  icon: ReactNode;
  tone: 'warn' | 'final';
  onClick?: () => void;
}

function buildBriefing(
  insights: OwnerInsightsSummary,
  cashFlow: CashFlowSummary,
  categories: Category[],
): Briefing {
  const netCents = insights.closeSummary.netCents;
  // Pull prior-year same-period from cash flow periods (last entry = current month).
  const thisMonth = cashFlow.periods.at(-1);
  const lastMonth = cashFlow.periods.length >= 2 ? cashFlow.periods.at(-2)! : null;
  const previousNetCents = thisMonth?.previousNetCents ?? 0;
  const yoyDelta = previousNetCents !== 0
    ? Math.round(((netCents - previousNetCents) / Math.abs(previousNetCents)) * 100)
    : 0;

  const inflowDelta = lastMonth && lastMonth.inflowCents !== 0
    ? Math.round(((insights.closeSummary.inflowCents - lastMonth.inflowCents) / Math.abs(lastMonth.inflowCents)) * 100)
    : 0;
  const outflowDelta = lastMonth && lastMonth.outflowCents !== 0
    ? Math.round(((insights.closeSummary.outflowCents - lastMonth.outflowCents) / Math.abs(lastMonth.outflowCents)) * 100)
    : 0;

  const netSpark = cashFlow.periods.map((p) => p.netCents);

  // Stories: surface the most interesting category change, biggest business mover, and largest purchase.
  const stories: BriefingStory[] = [];

  // Largest category delta (positive = spend grew = concern; negative = spend dropped = win).
  if (categories.length > 0) {
    const ranked = [...categories]
      .filter((c) => c.delta && c.delta !== '0%')
      .sort((a, b) => Math.abs(parseDelta(b.delta)) - Math.abs(parseDelta(a.delta)));
    const spike = ranked.find((c) => parseDelta(c.delta) > 0);
    if (spike) {
      stories.push({
        tag: 'Spend spike',
        tone: 'coral',
        head: `${spike.name} up ${spike.delta}`,
        body: `Pacing ${spike.delta} vs prior period across ${spike.count} transaction${spike.count === 1 ? '' : 's'}.`,
        stat: spike.delta,
        statLabel: 'vs prior period',
      });
    }
    const win = ranked.find((c) => parseDelta(c.delta) < 0);
    if (win) {
      stories.push({
        tag: 'Win',
        tone: 'sage',
        head: `${win.name} down ${win.delta.replace('-', '')}`,
        body: `Trimmed spend on ${win.name.toLowerCase()} vs prior period — keeping the trend.`,
        stat: win.delta,
        statLabel: 'vs prior period',
      });
    }
  }

  if (insights.missingReceipts.count > 0) {
    stories.push({
      tag: 'Receipts',
      tone: 'lemon',
      head: `${insights.missingReceipts.count} missing receipt${insights.missingReceipts.count === 1 ? '' : 's'}`,
      body: `${fmt$(insights.missingReceipts.cents / 100)} of outflow still needs documentation before close.`,
      stat: `${insights.missingReceipts.count}`,
      statLabel: 'to find',
    });
  }

  // Cap at 3 cards
  const trimmedStories = stories.slice(0, 3);

  // Narrative — narrative sentence built from real numbers.
  const narrativeParts: string[] = [];
  if (netCents >= 0) {
    narrativeParts.push(
      `You're net positive at ${fmt$(netCents / 100)} so far this period (${insights.closeSummary.transactionCount} txns reviewed).`,
    );
  } else {
    narrativeParts.push(
      `You're net negative at ${fmt$(netCents / 100)} this period — outflow outpaced inflow across ${insights.closeSummary.transactionCount} txns.`,
    );
  }
  if (previousNetCents !== 0) {
    narrativeParts.push(
      yoyDelta >= 0
        ? `That's up ${yoyDelta}% vs the same period last year (${fmt$(previousNetCents / 100)}).`
        : `That's ${Math.abs(yoyDelta)}% behind the same period last year (${fmt$(previousNetCents / 100)}).`,
    );
  }
  if (insights.incomeByBusiness.length > 0) {
    const top = [...insights.incomeByBusiness].sort((a, b) => b.cents - a.cents)[0];
    narrativeParts.push(
      `${top.businessName} is leading on inflow at ${fmt$(top.cents / 100)} across ${top.count} deposit${top.count === 1 ? '' : 's'}.`,
    );
  }
  if (insights.uncategorized.count > 0 || insights.missingReceipts.count > 0) {
    const bits: string[] = [];
    if (insights.missingReceipts.count > 0) {
      bits.push(`${insights.missingReceipts.count} missing receipts (${fmt$(insights.missingReceipts.cents / 100)})`);
    }
    if (insights.uncategorized.count > 0) {
      bits.push(`${insights.uncategorized.count} uncategorized txns (${fmt$(insights.uncategorized.cents / 100)})`);
    }
    narrativeParts.push(`Before close, clean up ${bits.join(' and ')}.`);
  }
  const narrative = narrativeParts.join(' ');

  // Headline: lead with net cash YoY (or net vs zero if no YoY).
  let headlinePrefix: string;
  let headlineAccent: string;
  let headlineAccentTone: 'positive' | 'warning';
  let headlineSuffix: string | undefined;
  if (previousNetCents !== 0) {
    headlinePrefix = 'Net cash is';
    headlineAccent = yoyDelta >= 0
      ? `up +${yoyDelta}% YoY`
      : `down ${Math.abs(yoyDelta)}% YoY`;
    headlineAccentTone = yoyDelta >= 0 ? 'positive' : 'warning';
    if (insights.missingReceipts.count > 0) {
      headlineSuffix = `but ${insights.missingReceipts.count} receipt${insights.missingReceipts.count === 1 ? '' : 's'} still need attention.`;
    }
  } else if (netCents >= 0) {
    headlinePrefix = 'You are tracking';
    headlineAccent = `${fmt$(netCents / 100)} in the green`;
    headlineAccentTone = 'positive';
  } else {
    headlinePrefix = 'You are running';
    headlineAccent = `${fmt$(netCents / 100)}`;
    headlineAccentTone = 'warning';
    headlineSuffix = 'this period — outflow is ahead of inflow.';
  }

  const closeItems: CloseItem[] = [];
  if (insights.missingReceipts.count > 0) {
    closeItems.push({
      label: `Find ${insights.missingReceipts.count} missing receipt${insights.missingReceipts.count === 1 ? '' : 's'}`,
      icon: <ReceiptIcon className="h-3.5 w-3.5" />,
      tone: 'warn',
    });
  }
  if (insights.uncategorized.count > 0) {
    closeItems.push({
      label: `Categorize ${insights.uncategorized.count} transaction${insights.uncategorized.count === 1 ? '' : 's'}`,
      icon: <Boxes className="h-3.5 w-3.5" />,
      tone: 'warn',
    });
  }
  if (insights.transfers.count > 0) {
    closeItems.push({
      label: `Audit ${insights.transfers.count} transfer${insights.transfers.count === 1 ? '' : 's'}`,
      icon: <TriangleAlert className="h-3.5 w-3.5" />,
      tone: 'warn',
    });
  }
  if (closeItems.length === 0) {
    closeItems.push({
      label: 'Sign off period close',
      icon: <CheckCircle className="h-3.5 w-3.5" />,
      tone: 'final',
    });
  }

  return {
    headlinePrefix,
    headlineAccent,
    headlineAccentTone,
    headlineSuffix,
    narrative,
    netYoYDelta: yoyDelta,
    previousNetCents,
    netSpark,
    inflowDelta,
    outflowDelta,
    stories: trimmedStories,
    closeItems,
  };
}

function BusinessScorecard({
  cashFlow,
  insights,
}: {
  cashFlow: CashFlowSummary;
  insights: OwnerInsightsSummary;
}) {
  // Pull business breakdown from the latest period; sparkline uses 12-month series per business.
  const latest = cashFlow.periods.at(-1);
  const lastMonth = cashFlow.periods.length >= 2 ? cashFlow.periods.at(-2)! : null;
  if (!latest || latest.businessBreakdown.length === 0) {
    return <div className="py-6 text-center text-sm text-dim">No business breakdown.</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-ink2/10 text-left font-mono text-[10px] font-medium uppercase tracking-wider text-dim">
            <th className="py-2">Business</th>
            <th className="py-2 text-right">Inflow</th>
            <th className="py-2 text-right">Outflow</th>
            <th className="py-2 text-right">Net</th>
            <th className="py-2 text-right">MoM</th>
            <th className="py-2 text-right">YoY</th>
            <th className="py-2 pl-3">12-mo trend</th>
          </tr>
        </thead>
        <tbody>
          {latest.businessBreakdown.map((row) => {
            const prevMonth = lastMonth?.businessBreakdown.find((b) => b.businessId === row.businessId);
            const mom = prevMonth && prevMonth.netCents !== 0
              ? Math.round(((row.netCents - prevMonth.netCents) / Math.abs(prevMonth.netCents)) * 100)
              : 0;
            const yoy = latest.previousNetCents !== 0 ? latest.netDeltaPct : 0;
            const spark = cashFlow.periods.map(
              (period) => period.businessBreakdown.find((b) => b.businessId === row.businessId)?.netCents ?? 0,
            );
            return (
              <tr key={row.businessId} className="border-b border-ink2/5 hover:bg-cream/40">
                <td className="py-3">
                  <span className="inline-flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: row.color }} />
                    <span className="font-bold text-ink">{row.businessName}</span>
                  </span>
                </td>
                <td className="py-3 text-right tabular-nums text-sage-ink">
                  +{fmt$(row.inflowCents / 100)}
                </td>
                <td className="py-3 text-right tabular-nums text-ink">−{fmt$(row.outflowCents / 100)}</td>
                <td
                  className={cn(
                    'py-3 text-right font-display font-bold tabular-nums',
                    row.netCents >= 0 ? 'text-sage-ink' : 'text-coral-ink',
                  )}
                >
                  {fmt$(row.netCents / 100)}
                </td>
                <td className="py-3 text-right">
                  <Delta value={mom} />
                </td>
                <td className="py-3 text-right">
                  <Delta value={yoy} />
                </td>
                <td className="py-3 pl-3">
                  <div className="h-8 w-32">
                    <Sparkline values={spark} color={row.color} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {insights.incomeByBusiness.length === 0 && (
        <div className="mt-3 text-xs text-dim">No inflow recorded yet for this period.</div>
      )}
    </div>
  );
}

function Delta({ value, invertColors }: { value: number; invertColors?: boolean }) {
  if (value === 0) return <span className="font-mono text-[10px] text-dim">—</span>;
  const positive = value >= 0;
  const Icon = positive ? ChevronUp : ChevronDown;
  // For outflow, positive number = bad. Invert color coding.
  const isPositiveSentiment = invertColors ? !positive : positive;
  return (
    <span
      className={cn(
        'inline-flex items-center justify-end gap-1 font-bold tabular-nums text-xs',
        isPositiveSentiment ? 'text-sage-ink' : 'text-coral-ink',
      )}
    >
      <Icon className="h-3 w-3" />
      {Math.abs(value)}%
    </span>
  );
}

function Sparkline({ values, color, positive }: { values: number[]; color?: string; positive?: boolean }) {
  const ink = useResolvedColor('--color-ink', '#15140f');
  if (!values.length) return null;
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const range = max - min || 1;
  const points = values.map((value, index) => {
    const x = (index / Math.max(values.length - 1, 1)) * 100;
    const y = 100 - ((value - min) / range) * 100;
    return `${x},${y}`;
  });
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full">
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke={positive ? 'hsl(105 35% 19%)' : (color ?? ink)}
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function parseDelta(value: string): number {
  if (!value) return 0;
  const trimmed = value.replace(/[%↗↘↑↓ ]/g, '').trim();
  const number = Number.parseFloat(trimmed);
  if (Number.isNaN(number)) return 0;
  if (/↗|↑/.test(value)) return Math.abs(number);
  if (/↘|↓/.test(value)) return -Math.abs(number);
  return number;
}

function exportInsightsCsv(summary: OwnerInsightsSummary) {
  const rows = [
    ['section', 'date', 'merchant', 'business', 'category', 'amount'],
    ...summary.topPurchases.map((purchase) => [
      'top_purchase',
      purchase.date,
      purchase.merchant,
      purchase.biz,
      purchase.cat,
      String(Math.abs(Math.round(purchase.amount * 100))),
    ]),
    ['close_summary', summary.from, 'inflow', '', '', String(summary.closeSummary.inflowCents)],
    ['close_summary', summary.from, 'outflow', '', '', String(summary.closeSummary.outflowCents)],
    ['close_summary', summary.from, 'net', '', '', String(summary.closeSummary.netCents)],
    ['close_summary', summary.from, 'uncategorized', '', '', String(summary.uncategorized.cents)],
    ['close_summary', summary.from, 'missing_receipts', '', '', String(summary.missingReceipts.cents)],
    ['close_summary', summary.from, 'transfers', '', '', String(summary.transfers.cents)],
  ];
  const csv = rows.map((row) => row.map(csvCell).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `ledger-insights-${summary.from}-${summary.to}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function startOfMonth(): string {
  return `${new Date().toISOString().slice(0, 7)}-01`;
}

function trailing12From(to: string): string {
  const date = new Date(`${to}T00:00:00`);
  date.setMonth(date.getMonth() - 11);
  date.setDate(1);
  return date.toISOString().slice(0, 10);
}
