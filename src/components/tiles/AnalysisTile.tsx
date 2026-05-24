import { useMemo, useState } from 'react';
import type { Account, Business, Transaction } from '@/types/domain';
import { accentRamp } from '@/theme/tokens';
import { fmt$k } from '@/lib/format';
import { accountLabel } from '@/lib/account';
import { Tile } from '@/components/ui/tile';
import { StatLabel } from '@/components/ui/stat-label';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ChartTooltip, useChartTooltip } from '@/components/ui/chart-tooltip';

type Mode = 'business' | 'category' | 'account' | 'receipt';

interface Props {
  businesses: Business[];
  accounts: Account[];
  transactions: Transaction[];
  onOpenTransactions: () => void;
}

interface AnalysisTipData {
  label: string;
  amount: number;
  count: number;
  share: number;
}

export function AnalysisTile({ businesses, accounts, transactions, onOpenTransactions }: Props) {
  const [mode, setMode] = useState<Mode>('category');
  const rows = useMemo(() => groupRows(mode, transactions, businesses, accounts), [accounts, businesses, mode, transactions]);
  const max = Math.max(...rows.map((row) => row.amount), 1);
  const total = rows.reduce((sum, row) => sum + row.amount, 0);
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
          <TabsTrigger value="category" className="h-7 text-[11px]">Category</TabsTrigger>
          <TabsTrigger value="account" className="h-7 text-[11px]">Account</TabsTrigger>
          <TabsTrigger value="business" className="h-7 text-[11px]">Business</TabsTrigger>
          <TabsTrigger value="receipt" className="h-7 text-[11px]">Receipts</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="grid grid-cols-2 gap-3">
        <Metric label="Outflow" value={fmt$k(total)} />
        <Metric label="Rows" value={String(transactions.length)} />
      </div>

      <div ref={containerRef} className="relative grid min-h-0 gap-2.5 overflow-auto" onMouseLeave={hide}>
        {rows.slice(0, 6).map((row, index) => {
          const data: AnalysisTipData = {
            label: row.label,
            amount: row.amount,
            count: row.count,
            share: total > 0 ? (row.amount / total) * 100 : 0,
          };
          return (
            <div
              key={row.label}
              className="grid gap-1 rounded-md px-1 py-0.5 transition-colors hover:bg-cream/60"
              onMouseEnter={(event) => show(data, event)}
              onMouseMove={(event) => show(data, event)}
            >
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-bold">{row.label}</span>
                <span className="text-xs text-dim">{row.count}</span>
                <span className="font-display text-sm font-bold tabular-nums">{fmt$k(row.amount)}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-[hsl(var(--color-sunken))]">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.max(4, (row.amount / max) * 100)}%`,
                    background: row.color ?? accentRamp[index % accentRamp.length],
                  }}
                />
              </div>
            </div>
          );
        })}
        {!rows.length && <div className="text-sm text-dim">No spend matches the current filters.</div>}
        <ChartTooltip open={tip.open} x={tip.x} y={tip.y}>
          {tip.data && (
            <>
              <div className="font-bold uppercase tracking-wider text-[10px] opacity-70">{tip.data.label}</div>
              <div className="font-display font-bold tabular-nums">{fmt$k(tip.data.amount)}</div>
              <div className="text-[10px] opacity-70">
                {tip.data.count} {tip.data.count === 1 ? 'txn' : 'txns'} · {tip.data.share.toFixed(1)}% of view
              </div>
            </>
          )}
        </ChartTooltip>
      </div>
    </Tile>
  );
}

function groupRows(mode: Mode, transactions: Transaction[], businesses: Business[], accounts: Account[]) {
  const businessById = new Map(businesses.map((business) => [business.id, business]));
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const rows = new Map<string, { label: string; amount: number; count: number; color?: string }>();
  for (const transaction of transactions) {
    if (transaction.amount >= 0) continue;
    const business = businessById.get(transaction.biz);
    const account = transaction.accountId ? accountById.get(transaction.accountId) : undefined;
    const label = labelFor(mode, transaction, business, account);
    const color = mode === 'business' ? business?.color : undefined;
    const row = rows.get(label) ?? { label, amount: 0, count: 0, color };
    row.amount += Math.abs(transaction.amount);
    row.count += 1;
    rows.set(label, row);
  }
  return [...rows.values()].sort((a, b) => b.amount - a.amount);
}

function labelFor(mode: Mode, transaction: Transaction, business?: Business, account?: Account): string {
  switch (mode) {
    case 'business':
      return business?.name ?? transaction.biz;
    case 'account':
      return account ? accountLabel(account) : transaction.src;
    case 'receipt':
      return transaction.receipt;
    default:
      return transaction.cat || 'Uncategorized';
  }
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-[hsl(var(--color-sunken))] px-3 py-2">
      <div className="font-mono text-[10px] uppercase tracking-wider text-dim">{label}</div>
      <div className="font-display text-lg font-bold tabular-nums">{value}</div>
    </div>
  );
}
