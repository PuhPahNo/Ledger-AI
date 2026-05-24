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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

type Mode = 'business' | 'category' | 'account' | 'receipt' | 'purchase';

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
  const [purchaseBusinessId, setPurchaseBusinessId] = useState('draft-sharks');
  const [purchaseCategory, setPurchaseCategory] = useState('Entertainment');
  const rows = useMemo(() => groupRows(mode, transactions, businesses, accounts), [accounts, businesses, mode, transactions]);
  const categoryOptions = useMemo(() => categoryNames(transactions), [transactions]);
  const activeBusinessId = businesses.some((business) => business.id === purchaseBusinessId)
    ? purchaseBusinessId
    : defaultBusinessId(businesses);
  const activeCategory = categoryOptions.includes(purchaseCategory)
    ? purchaseCategory
    : defaultCategory(categoryOptions);
  const purchaseRows = useMemo(
    () => topPurchases(transactions, activeBusinessId, activeCategory),
    [activeBusinessId, activeCategory, transactions],
  );
  const max = Math.max(
    ...(mode === 'purchase' ? purchaseRows.map((row) => Math.abs(row.amount)) : rows.map((row) => row.amount)),
    1,
  );
  const total = rows.reduce((sum, row) => sum + row.amount, 0);
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
          <TabsTrigger value="category" className="h-7 text-[11px]">Category</TabsTrigger>
          <TabsTrigger value="account" className="h-7 text-[11px]">Account</TabsTrigger>
          <TabsTrigger value="business" className="h-7 text-[11px]">Business</TabsTrigger>
          <TabsTrigger value="purchase" className="h-7 text-[11px]">Purchases</TabsTrigger>
          <TabsTrigger value="receipt" className="h-7 text-[11px]">Receipts</TabsTrigger>
        </TabsList>
      </Tabs>

      {mode === 'purchase' && (
        <div className="grid grid-cols-2 gap-2">
          <Select value={activeBusinessId} onValueChange={setPurchaseBusinessId}>
            <SelectTrigger className="h-8 rounded-md bg-paper px-2 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {businesses.map((business) => (
                <SelectItem key={business.id} value={business.id}>{business.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={activeCategory} onValueChange={setPurchaseCategory}>
            <SelectTrigger className="h-8 rounded-md bg-paper px-2 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {categoryOptions.map((category) => (
                <SelectItem key={category} value={category}>{category}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Metric label={mode === 'purchase' ? 'Selected' : 'Outflow'} value={fmt$k(mode === 'purchase' ? purchaseTotal : total)} />
        <Metric label={mode === 'purchase' ? 'Purchases' : 'Rows'} value={String(mode === 'purchase' ? purchaseRows.length : transactions.length)} />
      </div>

      <div ref={containerRef} className="relative grid min-h-0 gap-2.5 overflow-auto" onMouseLeave={hide}>
        {mode === 'purchase' ? purchaseRows.slice(0, 6).map((transaction, index) => {
          const amount = Math.abs(transaction.amount);
          const data: AnalysisTipData = {
            label: transaction.merchant,
            amount,
            count: 1,
            share: purchaseTotal > 0 ? (amount / purchaseTotal) * 100 : 0,
          };
          return (
            <div
              key={transaction.id}
              className="grid gap-1 rounded-md px-1 py-0.5 transition-colors hover:bg-cream/60"
              onMouseEnter={(event) => show(data, event)}
              onMouseMove={(event) => show(data, event)}
            >
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-bold">{transaction.merchant}</span>
                <span className="shrink-0 text-xs text-dim">{transaction.dateLabel}</span>
                <span className="shrink-0 font-display text-sm font-bold tabular-nums">{fmt$k(amount)}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-[hsl(var(--color-sunken))]">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.max(4, (amount / max) * 100)}%`,
                    background: businesses.find((business) => business.id === transaction.biz)?.color ?? accentRamp[index % accentRamp.length],
                  }}
                />
              </div>
            </div>
          );
        }) : rows.slice(0, 6).map((row, index) => {
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
        {mode !== 'purchase' && !rows.length && <div className="text-sm text-dim">No spend matches the current filters.</div>}
        {mode === 'purchase' && !purchaseRows.length && <div className="text-sm text-dim">No purchases match the current filters.</div>}
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

function topPurchases(transactions: Transaction[], businessId: string, category: string) {
  return transactions
    .filter((transaction) => transaction.amount < 0)
    .filter((transaction) => transaction.biz === businessId)
    .filter((transaction) => (transaction.cat || 'Uncategorized') === category)
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
}

function categoryNames(transactions: Transaction[]) {
  return [...new Set(
    transactions
      .filter((transaction) => transaction.amount < 0)
      .map((transaction) => transaction.cat || 'Uncategorized'),
  )].sort((a, b) => a.localeCompare(b));
}

function defaultBusinessId(businesses: Business[]) {
  return businesses.find((business) => business.id === 'draft-sharks' || business.name.toLowerCase() === 'draft sharks')?.id
    ?? businesses[0]?.id
    ?? '';
}

function defaultCategory(categories: string[]) {
  return categories.find((category) => category.toLowerCase() === 'entertainment')
    ?? categories[0]
    ?? '';
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
