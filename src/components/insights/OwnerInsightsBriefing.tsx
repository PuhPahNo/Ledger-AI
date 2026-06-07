import type { ReactNode } from 'react';
import { Boxes, CheckCircle, ChevronDown, ChevronUp, Download, Receipt as ReceiptIcon, TriangleAlert } from 'lucide-react';
import type { CashFlowSummary, Category, CloseReadinessItem, OwnerInsightsSummary } from '@/types/domain';
import { fmt$ } from '@/lib/format';
import { useResolvedColor, useTheme } from '@/hooks/useTheme';
import { cn } from '@/lib/cn';

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

export function iconForCloseItem(item: CloseReadinessItem): ReactNode {
  if (item.id.includes('receipt')) return <ReceiptIcon className="h-3.5 w-3.5" />;
  if (item.id.includes('categor') || item.id.includes('rule')) return <Boxes className="h-3.5 w-3.5" />;
  if (item.id.includes('transfer') || item.id.includes('sync')) return <TriangleAlert className="h-3.5 w-3.5" />;
  if (item.id.includes('export')) return <Download className="h-3.5 w-3.5" />;
  return <CheckCircle className="h-3.5 w-3.5" />;
}

export function buildBriefing(
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

export function BusinessScorecard({
  cashFlow,
  insights,
}: {
  cashFlow: CashFlowSummary;
  insights: OwnerInsightsSummary;
}) {
  // Pull business breakdown from the latest period; sparkline uses 12-month series per business.
  const latest = cashFlow.periods.at(-1);
  const lastMonth = cashFlow.periods.length >= 2 ? cashFlow.periods.at(-2)! : null;
  // List every business that had activity anywhere in the range — not just the latest month —
  // so a business with no latest-month activity still appears (with zeroed current figures).
  const businessMeta = new Map<string, { businessId: string; businessName: string; color: string }>();
  for (const period of cashFlow.periods) {
    for (const b of period.businessBreakdown) {
      if (!businessMeta.has(b.businessId)) {
        businessMeta.set(b.businessId, { businessId: b.businessId, businessName: b.businessName, color: b.color });
      }
    }
  }
  const latestById = new Map((latest?.businessBreakdown ?? []).map((b) => [b.businessId, b]));
  const scorecardRows = [...businessMeta.values()]
    .map((meta) => latestById.get(meta.businessId) ?? {
      ...meta,
      inflowCents: 0,
      outflowCents: 0,
      transferCents: 0,
      netCents: 0,
      previousNetCents: 0,
    })
    .sort((a, b) => b.netCents - a.netCents);
  if (scorecardRows.length === 0) {
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
          {scorecardRows.map((row) => {
            const prevMonth = lastMonth?.businessBreakdown.find((b) => b.businessId === row.businessId);
            const mom = prevMonth && prevMonth.netCents !== 0
              ? Math.round(((row.netCents - prevMonth.netCents) / Math.abs(prevMonth.netCents)) * 100)
              : 0;
            const yoy = row.previousNetCents !== 0
              ? Math.round(((row.netCents - row.previousNetCents) / Math.abs(row.previousNetCents)) * 100)
              : 0;
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

export function Delta({ value, invertColors }: { value: number; invertColors?: boolean }) {
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

export function Sparkline({ values, color, positive }: { values: number[]; color?: string; positive?: boolean }) {
  const { theme } = useTheme();
  const ink = useResolvedColor('--color-ink', '#15140f');
  // Positive trend green must contrast with the background: dark sage-ink on light,
  // light sage on dark (the dark green is invisible in dark mode).
  const positiveStroke = theme === 'dark' ? 'hsl(95 31% 70%)' : 'hsl(105 35% 19%)';
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
        stroke={positive ? positiveStroke : (color ?? ink)}
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

