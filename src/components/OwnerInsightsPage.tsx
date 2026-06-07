import { useEffect, useMemo, useState } from 'react';
import {
  ArrowUpRight,
  Check,
  CheckCircle,
  ChevronRight,
  Download,
  ExternalLink,
  Sparkles,
} from 'lucide-react';
import {
  getCashFlow,
  getCloseReadiness,
  getOwnerInsights,
  listBusinesses,
  listCategories,
  signOffClosePeriod,
  uploadReceipt,
} from '@/api';
import type {
  Business,
  CashFlowSummary,
  Category,
  CloseReadiness,
  CloseReadinessItem,
  CurrentUser,
  OwnerInsightsSummary,
} from '@/types/domain';
import type { AppView, TransactionViewFilters } from '@/types/navigation';
import { fmt$ } from '@/lib/format';
import { useToast } from '@/hooks/useToast';
import { AppShell } from './AppShell';
import { BusinessScorecard, Delta, Sparkline, buildBriefing, iconForCloseItem } from './insights/OwnerInsightsBriefing';
import { exportInsightsCsv, startOfMonth, today, trailing12From } from './insights/ownerInsightsUtils';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/cn';

interface Props {
  user?: CurrentUser;
  onViewChange?: (view: AppView) => void;
  onOpenTransactions?: (filters: TransactionViewFilters) => void;
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

const emptyCloseReadiness: CloseReadiness = {
  from: '',
  to: '',
  biz: 'all',
  signedOff: false,
  signedOffAt: null,
  canSignOff: false,
  items: [],
};

export function OwnerInsightsPage({ user, onViewChange, onOpenTransactions, onLogout }: Props) {
  const { toast } = useToast();
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [summary, setSummary] = useState<OwnerInsightsSummary>(emptyInsights);
  const [cashFlow, setCashFlow] = useState<CashFlowSummary>(emptyCashFlow);
  const [closeReadiness, setCloseReadiness] = useState<CloseReadiness>(emptyCloseReadiness);
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
      getCloseReadiness({ from, to, biz: business }),
    ])
      .then(([insightsResult, cashFlowResult, categoryRows, closeResult]) => {
        setSummary(insightsResult);
        setCashFlow(cashFlowResult);
        setCategories(categoryRows);
        setCloseReadiness(closeResult);
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

  const handleCloseItem = (item: CloseReadinessItem) => {
    if (item.actionView === 'transactions') {
      onOpenTransactions?.({
        business,
        from,
        to,
        direction: typeof item.filters?.direction === 'string' ? item.filters.direction as TransactionViewFilters['direction'] : undefined,
        receipts: Array.isArray(item.filters?.receipts) ? item.filters.receipts as TransactionViewFilters['receipts'] : undefined,
        categories: Array.isArray(item.filters?.categories) ? item.filters.categories as string[] : undefined,
      });
      return;
    }
    onViewChange?.(item.actionView);
  };

  const handleSignOff = async () => {
    try {
      const result = await signOffClosePeriod({ from, to, biz: business });
      setCloseReadiness(result);
      toast({ variant: 'success', title: 'Period signed off', description: `${from} to ${to}` });
    } catch (signOffError) {
      toast({
        variant: 'destructive',
        title: 'Close sign-off blocked',
        description: signOffError instanceof Error ? signOffError.message : 'Clear close blockers first.',
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
                // lemon-ink stays dark (it's mostly used on solid bright lemon chips), so on these
                // tinted cards it needs a light lemon in dark mode. sage-ink/coral-ink already flip.
                lemon: { bg: 'bg-lemon/30', tag: 'bg-lemon-ink/10 text-lemon-ink dark:bg-lemon/15 dark:text-lemon', stat: 'text-lemon-ink dark:text-lemon' },
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
                <h3 className="font-display text-lg font-bold text-ink">
                  {closeReadiness.signedOff ? 'Signed off' : `${closeReadiness.items.length} item${closeReadiness.items.length === 1 ? '' : 's'} left`}
                </h3>
                {closeReadiness.signedOffAt && (
                  <div className="text-xs text-dim">Signed {new Date(closeReadiness.signedOffAt).toLocaleString()}</div>
                )}
              </div>
              {closeReadiness.canSignOff ? (
                <Button size="sm" onClick={handleSignOff}>
                  <CheckCircle className="h-3.5 w-3.5" />
                  Sign off
                </Button>
              ) : closeReadiness.items.length > 0 && (
                <Button size="sm" onClick={() => handleCloseItem(closeReadiness.items[0])}>
                  Start close
                </Button>
              )}
            </div>
            {closeReadiness.signedOff ? (
              <div className="rounded-lg bg-sage/15 p-4 text-sm font-bold text-sage-ink">
                <CheckCircle className="mb-2 inline h-4 w-4" /> This period has been signed off.
              </div>
            ) : closeReadiness.items.length === 0 ? (
              <div className="rounded-lg bg-sage/15 p-4 text-sm font-bold text-sage-ink">
                <CheckCircle className="mb-2 inline h-4 w-4" /> Everything is clean for this period.
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {closeReadiness.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => item.id === 'sign-off' ? void handleSignOff() : handleCloseItem(item)}
                    className="group flex items-center gap-3 rounded-lg bg-[hsl(var(--color-sunken))] px-3 py-2 text-left transition-colors hover:bg-cream"
                  >
                    <span
                      className={cn(
                        'flex h-7 w-7 items-center justify-center rounded-lg',
                        item.severity === 'blocker' ? 'bg-coral/20 text-coral-ink' : item.severity === 'review' ? 'bg-lemon/40 text-lemon-ink' : 'bg-inverse text-inverse-foreground',
                      )}
                    >
                      {iconForCloseItem(item)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-bold text-ink">{item.label}</span>
                      <span className="block truncate text-xs text-dim">{item.detail}</span>
                    </span>
                    <ExternalLink className="h-3.5 w-3.5 text-dim group-hover:text-ink" />
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
