import { useEffect, useMemo, useState } from 'react';
import { ArrowDownUp, X } from 'lucide-react';
import { listTransactions } from '@/api';
import type { Account, Business, Category, ReceiptStatus, Transaction } from '@/types/domain';
import { fmt$, fmt$k } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/ui/empty-state';

type SortKey = 'date' | 'amount' | 'merchant' | 'business' | 'category' | 'account';

interface Props {
  open: boolean;
  businesses: Business[];
  accounts: Account[];
  categories: Category[];
  initialBusiness: string;
  initialAccountIds: string[];
  initialQuery: string;
  onClose: () => void;
  onSelect: (transaction: Transaction) => void;
}

const receiptOptions: ReceiptStatus[] = ['missing', 'pending', 'matched', 'n/a'];

export function TransactionExplorer({
  open,
  businesses,
  accounts,
  categories,
  initialBusiness,
  initialAccountIds,
  initialQuery,
  onClose,
  onSelect,
}: Props) {
  const [business, setBusiness] = useState(initialBusiness);
  const [accountIds, setAccountIds] = useState<string[]>(initialAccountIds);
  const [categoryNames, setCategoryNames] = useState<string[]>([]);
  const [receipts, setReceipts] = useState<ReceiptStatus[]>([]);
  const [query, setQuery] = useState(initialQuery);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sort, setSort] = useState<SortKey>('date');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [rows, setRows] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setBusiness(initialBusiness);
    setAccountIds(initialAccountIds);
    setQuery(initialQuery);
  }, [initialAccountIds, initialBusiness, initialQuery, open]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError('');
    listTransactions({
      biz: business,
      accountIds,
      categories: categoryNames,
      receipts,
      q: query || undefined,
      from: from || undefined,
      to: to || undefined,
      sort,
      dir,
      limit: 2000,
    })
      .then(setRows)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [accountIds, business, categoryNames, dir, from, open, query, receipts, sort, to]);

  const businessById = useMemo(() => new Map(businesses.map((item) => [item.id, item])), [businesses]);
  const accountById = useMemo(() => new Map(accounts.map((item) => [item.id, item])), [accounts]);
  const outflow = rows.filter((row) => row.amount < 0).reduce((sum, row) => sum + Math.abs(row.amount), 0);
  const missing = rows.filter((row) => row.receipt === 'missing').length;
  const visibleAccounts = business === 'all' ? accounts : accounts.filter((account) => account.biz === business);
  const topCategories = categories.slice(0, 12);

  const toggleSort = (key: SortKey) => {
    if (sort === key) setDir((current) => (current === 'asc' ? 'desc' : 'asc'));
    else {
      setSort(key);
      setDir(key === 'merchant' ? 'asc' : 'desc');
    }
  };

  const showLast12Months = () => {
    const end = new Date();
    const start = new Date();
    start.setMonth(start.getMonth() - 12);
    setFrom(toIsoDate(start));
    setTo(toIsoDate(end));
  };

  const clearFilters = () => {
    setAccountIds([]);
    setCategoryNames([]);
    setReceipts([]);
    setQuery('');
    setFrom('');
    setTo('');
  };

  const activeFilterCount = accountIds.length + categoryNames.length + receipts.length + (query ? 1 : 0) + (from || to ? 1 : 0);

  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent size="full" className="grid grid-rows-[auto_auto_auto_minmax(0,1fr)] gap-4">
        <DialogHeader className="flex flex-row items-center gap-3">
          <div className="min-w-0 flex-1">
            <DialogTitle>Transactions</DialogTitle>
            <DialogDescription>Filter, sort, and inspect every synced spend row.</DialogDescription>
          </div>
          <Metric label="Outflow" value={fmt$k(outflow)} />
          <Metric label="Rows" value={String(rows.length)} />
          <Metric label="Missing" value={String(missing)} tone={missing > 0 ? 'warning' : 'default'} />
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-[200px_minmax(0,1fr)_160px_160px_auto]">
          <div className="grid gap-1.5">
            <Label htmlFor="explorer-business">Business</Label>
            <Select
              value={business}
              onValueChange={(value) => {
                setBusiness(value);
                setAccountIds([]);
              }}
            >
              <SelectTrigger id="explorer-business">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All businesses</SelectItem>
                {businesses.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="explorer-search">Search</Label>
            <Input
              id="explorer-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Merchant, note, category"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="explorer-from">From</Label>
            <Input id="explorer-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="explorer-to">To</Label>
            <Input id="explorer-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </div>
          <div className="flex items-end gap-2">
            <Button variant="outline" size="sm" onClick={showLast12Months}>
              Last 12m
            </Button>
            <Button variant="ghost" size="sm" onClick={clearFilters} disabled={activeFilterCount === 0}>
              Clear
            </Button>
          </div>
        </div>

        <Card>
          <CardHeader className="flex flex-row items-baseline gap-3 py-3">
            <CardTitle className="text-base">Filters</CardTitle>
            <span className="text-xs text-dim">{activeFilterCount} active</span>
          </CardHeader>
          <CardContent className="grid gap-3 pt-0">
            <ChipGroup label="Accounts">
              {visibleAccounts.length ? visibleAccounts.map((account) => (
                <FilterChip
                  key={account.id}
                  active={accountIds.includes(account.id)}
                  muted={!account.enabled}
                  onClick={() => toggle(account.id, accountIds, setAccountIds)}
                >
                  {account.name}
                  {account.mask ? ` ${account.mask}` : ''}
                </FilterChip>
              )) : <span className="text-xs text-dim">No accounts in this business.</span>}
            </ChipGroup>
            <ChipGroup label="Categories">
              {topCategories.map((category) => (
                <FilterChip
                  key={category.name}
                  active={categoryNames.includes(category.name)}
                  onClick={() => toggle(category.name, categoryNames, setCategoryNames)}
                >
                  {category.name}
                </FilterChip>
              ))}
            </ChipGroup>
            <ChipGroup label="Receipts">
              {receiptOptions.map((receipt) => (
                <FilterChip
                  key={receipt}
                  active={receipts.includes(receipt)}
                  onClick={() => toggle(receipt, receipts, setReceipts)}
                >
                  {receipt}
                </FilterChip>
              ))}
            </ChipGroup>
          </CardContent>
        </Card>

        <div className="min-h-0 overflow-hidden rounded-lg border border-ink2/10">
          {error ? (
            <div className="p-4 text-sm text-coral-ink">{error}</div>
          ) : (
            <ScrollArea className="h-full">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortHeader active={sort === 'date'} dir={dir} onClick={() => toggleSort('date')}>Date</SortHeader>
                    <SortHeader active={sort === 'merchant'} dir={dir} onClick={() => toggleSort('merchant')}>Merchant</SortHeader>
                    <SortHeader active={sort === 'business'} dir={dir} onClick={() => toggleSort('business')}>Business</SortHeader>
                    <SortHeader active={sort === 'account'} dir={dir} onClick={() => toggleSort('account')}>Account</SortHeader>
                    <SortHeader active={sort === 'category'} dir={dir} onClick={() => toggleSort('category')}>Category</SortHeader>
                    <SortHeader active={sort === 'amount'} dir={dir} onClick={() => toggleSort('amount')} align="right">Amount</SortHeader>
                    <TableHead>Receipt</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((transaction) => {
                    const b = businessById.get(transaction.biz);
                    const account = transaction.accountId ? accountById.get(transaction.accountId) : undefined;
                    return (
                      <TableRow key={transaction.id} onClick={() => onSelect(transaction)} className="cursor-pointer">
                        <TableCell className="whitespace-nowrap text-dim">{transaction.date}</TableCell>
                        <TableCell className="font-bold text-ink">{transaction.merchant}</TableCell>
                        <TableCell>{b?.name ?? transaction.biz}</TableCell>
                        <TableCell className="text-dim">{account?.name ?? transaction.src}</TableCell>
                        <TableCell>{transaction.cat}</TableCell>
                        <TableCell className="text-right font-display font-bold tabular-nums">
                          {fmt$(transaction.amount)}
                        </TableCell>
                        <TableCell>
                          <ReceiptPill status={transaction.receipt} />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              {loading && <div className="p-6 text-center text-sm text-dim">Loading transactions…</div>}
              {!loading && !rows.length && (
                <div className="p-8">
                  <EmptyState title="No matches" description="No transactions match these filters. Try clearing them." />
                </div>
              )}
            </ScrollArea>
          )}
        </div>

        <DialogCloseBar onClose={onClose} />
      </DialogContent>
    </Dialog>
  );
}

function DialogCloseBar({ onClose }: { onClose: () => void }) {
  // Render an in-flow close button so it stays visible when content scrolls; the built-in × also handles it.
  return (
    <div className="absolute right-4 top-4 sm:hidden">
      <Button variant="ghost" size="icon-sm" onClick={onClose}>
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}

function toggle<T>(value: T, values: T[], setter: (values: T[]) => void) {
  setter(values.includes(value) ? values.filter((item) => item !== value) : [...values, value]);
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function Metric({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'warning' }) {
  return (
    <div
      className={cn(
        'rounded-md border px-3 py-1.5 text-right',
        tone === 'warning' ? 'border-coral/40 bg-coral/10 text-coral-ink' : 'border-ink2/10 bg-[hsl(var(--color-sunken))]',
      )}
    >
      <div className="font-mono text-[10px] uppercase tracking-wider text-dim">{label}</div>
      <div className="font-display text-base font-bold tabular-nums">{value}</div>
    </div>
  );
}

function ChipGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <div className="font-mono text-[10px] uppercase tracking-wider text-dim">{label}</div>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function FilterChip({
  active,
  muted,
  children,
  onClick,
}: {
  active: boolean;
  muted?: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-bold transition-colors',
        active
          ? 'border-ink bg-ink text-lemon'
          : 'border-ink2/20 bg-paper text-ink hover:border-ink2/40',
        muted && 'opacity-60',
      )}
    >
      {children}
      {active && <X className="h-3 w-3" />}
    </button>
  );
}

function SortHeader({
  active,
  dir,
  align,
  children,
  onClick,
}: {
  active: boolean;
  dir: 'asc' | 'desc';
  align?: 'right';
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <TableHead className={align === 'right' ? 'text-right' : undefined}>
      <button
        type="button"
        onClick={onClick}
        className="inline-flex items-center gap-1.5 font-bold uppercase tracking-wider text-cream/90 hover:text-cream"
      >
        {children}
        {active && (
          <ArrowDownUp
            className={cn('h-3 w-3 transition-transform', dir === 'asc' && 'rotate-180')}
          />
        )}
      </button>
    </TableHead>
  );
}

function ReceiptPill({ status }: { status: ReceiptStatus }) {
  const variant = status === 'missing' ? 'danger' : status === 'matched' ? 'success' : status === 'pending' ? 'warning' : 'muted';
  return <Badge variant={variant}>{status}</Badge>;
}
