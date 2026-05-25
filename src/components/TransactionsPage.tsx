import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowDownUp, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import {
  getTransactionRollup,
  listAccounts,
  listBusinesses,
  listCategories,
  listTransactions,
  uploadReceipt,
} from '@/api';
import type {
  Account,
  Business,
  Category,
  CurrentUser,
  ReceiptStatus,
  Transaction,
  TransactionDirection,
  TransactionRollup,
} from '@/types/domain';
import type { AppView, TransactionViewFilters } from '@/types/navigation';
import { accountLabel } from '@/lib/account';
import { fmt$ } from '@/lib/format';
import { useToast } from '@/hooks/useToast';
import { HeaderBar } from './HeaderBar';
import { TransactionDrawer } from './TransactionDrawer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/cn';

type SortKey = 'date' | 'amount' | 'largest' | 'merchant' | 'business' | 'category' | 'account';

interface Props {
  user?: CurrentUser;
  onViewChange?: (view: AppView) => void;
  onLogout?: () => void;
  initialFilters?: TransactionViewFilters;
}

const receiptOptions: ReceiptStatus[] = ['missing', 'pending', 'matched', 'n/a'];
const limit = 100;

export function TransactionsPage({ user, onViewChange, onLogout, initialFilters }: Props) {
  const { toast } = useToast();
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [business, setBusiness] = useState(initialFilters?.business ?? 'all');
  const [accountIds, setAccountIds] = useState<string[]>(initialFilters?.accountIds ?? []);
  const [categoryName, setCategoryName] = useState('all');
  const [receipts, setReceipts] = useState<ReceiptStatus[]>([]);
  const [direction, setDirection] = useState<TransactionDirection>('all');
  const [query, setQuery] = useState(initialFilters?.query ?? '');
  const [from, setFrom] = useState(initialFilters?.from ?? defaultFrom());
  const [to, setTo] = useState(initialFilters?.to ?? today());
  const [sort, setSort] = useState<SortKey>('date');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<Transaction[]>([]);
  const [rollup, setRollup] = useState<TransactionRollup>(emptyRollup);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null);

  useEffect(() => {
    setBusiness(initialFilters?.business ?? 'all');
    setAccountIds(initialFilters?.accountIds ?? []);
    setQuery(initialFilters?.query ?? '');
    setFrom(initialFilters?.from ?? defaultFrom());
    setTo(initialFilters?.to ?? today());
    setOffset(0);
  }, [initialFilters]);

  useEffect(() => {
    Promise.all([listBusinesses(), listAccounts(), listCategories()])
      .then(([businessRows, accountRows, categoryRows]) => {
        setBusinesses(businessRows);
        setAccounts(accountRows);
        setCategories(categoryRows);
      })
      .catch((loadError: Error) => {
        setError(loadError.message);
      });
  }, []);

  useEffect(() => {
    const categoryNames = categoryName === 'all' ? [] : [categoryName];
    setLoading(true);
    setError('');
    Promise.all([
      listTransactions({
        biz: business,
        accountIds,
        categories: categoryNames,
        receipts,
        direction,
        q: query || undefined,
        from: from || undefined,
        to: to || undefined,
        sort,
        dir,
        limit,
        offset,
      }),
      getTransactionRollup({
        biz: business,
        accountIds,
        categories: categoryNames,
        receipts,
        direction,
        q: query || undefined,
        from: from || undefined,
        to: to || undefined,
      }),
    ])
      .then(([transactionRows, summary]) => {
        setRows(transactionRows);
        setRollup(summary);
      })
      .catch((loadError: Error) => setError(loadError.message))
      .finally(() => setLoading(false));
  }, [accountIds, business, categoryName, dir, direction, from, offset, query, receipts, refreshKey, sort, to]);

  const businessById = useMemo(() => new Map(businesses.map((item) => [item.id, item])), [businesses]);
  const accountById = useMemo(() => new Map(accounts.map((item) => [item.id, item])), [accounts]);
  const visibleAccounts = business === 'all' ? accounts : accounts.filter((account) => account.biz === business);
  const categoryOptions = useMemo(() => {
    const names = new Set<string>();
    categories.forEach((category) => names.add(category.name));
    rows.forEach((transaction) => names.add(transaction.cat || 'Uncategorized'));
    if (categoryName !== 'all') names.add(categoryName);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [categories, categoryName, rows]);

  const openLargestDraftSharksEntertainment = () => {
    const draftSharks = businesses.find((item) => item.id === 'draft-sharks' || item.name.toLowerCase() === 'draft sharks');
    setBusiness(draftSharks?.id ?? 'draft-sharks');
    setAccountIds([]);
    setCategoryName('Entertainment');
    setDirection('operating-outflow');
    setSort('largest');
    setDir('desc');
    setOffset(0);
  };

  const clearFilters = () => {
    setBusiness('all');
    setAccountIds([]);
    setCategoryName('all');
    setReceipts([]);
    setDirection('all');
    setQuery('');
    setFrom(defaultFrom());
    setTo(today());
    setSort('date');
    setDir('desc');
    setOffset(0);
  };

  const handleUpload = async (file: File) => {
    try {
      const selectedBusiness = businesses.find((item) => item.id === business);
      await uploadReceipt(file, selectedBusiness?.dbId);
      toast({ variant: 'success', title: 'Receipt queued', description: 'OCR and matching will run in the background.' });
      setRefreshKey((key) => key + 1);
    } catch (uploadError) {
      toast({
        variant: 'destructive',
        title: 'Upload failed',
        description: uploadError instanceof Error ? uploadError.message : 'Try again.',
      });
    }
  };

  return (
    <div className="min-h-screen bg-bg text-ink">
      <div className="mx-auto flex max-w-[1500px] flex-col gap-4 p-4">
        <HeaderBar
          onUploadReceipt={handleUpload}
          currentView="transactions"
          onViewChange={onViewChange}
          onLogout={onLogout}
          user={user}
          query={query}
          onQueryChange={(value) => {
            setQuery(value);
            setOffset(0);
          }}
        />

        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">Workspace</div>
            <h1 className="font-display text-3xl font-bold tracking-tight">Transactions</h1>
          </div>
          <Button variant="outline" onClick={openLargestDraftSharksEntertainment}>
            <Search className="h-4 w-4" />
            Draft Sharks Entertainment
          </Button>
          <Button variant="ghost" onClick={clearFilters}>Clear</Button>
        </div>

        <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Metric label="Inflow" value={fmt$(rollup.inflowCents / 100)} tone="positive" />
          <Metric label="Operating Outflow" value={fmt$(rollup.operatingOutflowCents / 100)} />
          <Metric label="Total Outflow" value={fmt$(rollup.outflowCents / 100)} />
          <Metric label="Net" value={fmt$(rollup.netCents / 100)} tone={rollup.netCents >= 0 ? 'positive' : 'warning'} />
          <Metric label="Transfers" value={fmt$(rollup.transferCents / 100)} tone="muted" />
          <Metric label="Rows / Missing" value={`${rollup.rows} / ${rollup.missingReceipts}`} tone={rollup.missingReceipts > 0 ? 'warning' : 'muted'} />
        </div>

        <div className="grid gap-3 rounded-xl border border-ink2/10 bg-paper p-3 shadow-sm lg:grid-cols-[180px_180px_180px_180px_1fr]">
          <Field label="Business">
            <Select
              value={business}
              onValueChange={(value) => {
                setBusiness(value);
                setAccountIds([]);
                setOffset(0);
              }}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All businesses</SelectItem>
                {businesses.map((item) => (
                  <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Direction">
            <Select value={direction} onValueChange={(value) => { setDirection(value as TransactionDirection); setOffset(0); }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All movement</SelectItem>
                <SelectItem value="inflow">Inflows</SelectItem>
                <SelectItem value="outflow">Outflows</SelectItem>
                <SelectItem value="operating-outflow">Operating outflows</SelectItem>
                <SelectItem value="transfer">Transfers</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Category">
            <Select value={categoryName} onValueChange={(value) => { setCategoryName(value); setOffset(0); }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {categoryOptions.map((name) => (
                  <SelectItem key={name} value={name}>{name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Sort">
            <Select value={sort} onValueChange={(value) => { setSort(value as SortKey); setOffset(0); }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="date">Date</SelectItem>
                <SelectItem value="largest">Largest amount</SelectItem>
                <SelectItem value="amount">Signed amount</SelectItem>
                <SelectItem value="merchant">Merchant</SelectItem>
                <SelectItem value="business">Business</SelectItem>
                <SelectItem value="category">Category</SelectItem>
                <SelectItem value="account">Account</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
            <Field label="From">
              <Input type="date" value={from} onChange={(event) => { setFrom(event.target.value); setOffset(0); }} />
            </Field>
            <Field label="To">
              <Input type="date" value={to} onChange={(event) => { setTo(event.target.value); setOffset(0); }} />
            </Field>
            <div className="flex items-end">
              <Button variant="outline" className="w-full" onClick={() => setDir((value) => (value === 'asc' ? 'desc' : 'asc'))}>
                <ArrowDownUp className="h-4 w-4" />
                {dir.toUpperCase()}
              </Button>
            </div>
          </div>

          <div className="lg:col-span-5">
            <FilterGroup label="Accounts">
              {visibleAccounts.length ? visibleAccounts.map((account) => (
                <FilterChip
                  key={account.id}
                  active={accountIds.includes(account.id)}
                  muted={!account.enabled}
                  onClick={() => {
                    setAccountIds((current) => toggle(account.id, current));
                    setOffset(0);
                  }}
                >
                  {accountLabel(account)}
                  {account.mask ? ` ${account.mask}` : ''}
                </FilterChip>
              )) : <span className="text-xs text-dim">No accounts match this business.</span>}
            </FilterGroup>
            <FilterGroup label="Receipts">
              {receiptOptions.map((receipt) => (
                <FilterChip
                  key={receipt}
                  active={receipts.includes(receipt)}
                  onClick={() => {
                    setReceipts((current) => toggle(receipt, current));
                    setOffset(0);
                  }}
                >
                  {receipt}
                </FilterChip>
              ))}
            </FilterGroup>
          </div>
        </div>

        <div className="overflow-hidden rounded-xl border border-ink2/10 bg-paper shadow-sm">
          {error ? (
            <div className="p-4 text-sm font-bold text-coral-ink">{error}</div>
          ) : (
            <>
              <Table className="table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-28">Date</TableHead>
                    <TableHead>Merchant</TableHead>
                    <TableHead className="w-44">Business</TableHead>
                    <TableHead className="w-48">Account</TableHead>
                    <TableHead className="w-40">Category</TableHead>
                    <TableHead className="w-32 text-right">Amount</TableHead>
                    <TableHead className="w-28">Receipt</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((transaction) => {
                    const rowBusiness = businessById.get(transaction.biz);
                    const account = transaction.accountId ? accountById.get(transaction.accountId) : undefined;
                    return (
                      <TableRow key={transaction.id} onClick={() => setSelectedTransaction(transaction)} className="cursor-pointer">
                        <TableCell className="whitespace-nowrap text-dim">{transaction.date}</TableCell>
                        <TableCell>
                          <div className="min-w-0 truncate font-bold" title={transaction.merchant}>{transaction.merchant}</div>
                          {transaction.note && <div className="truncate text-xs text-dim">{transaction.note}</div>}
                        </TableCell>
                        <TableCell className="truncate">{rowBusiness?.name ?? transaction.biz}</TableCell>
                        <TableCell className="truncate text-dim">{account ? accountLabel(account) : transaction.src}</TableCell>
                        <TableCell className="truncate">{transaction.cat}</TableCell>
                        <TableCell className={cn('text-right font-display font-bold tabular-nums', transaction.amount > 0 && 'text-sage-ink')}>
                          {fmt$(transaction.amount)}
                        </TableCell>
                        <TableCell><ReceiptPill status={transaction.receipt} /></TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              {loading && <div className="p-6 text-center text-sm text-dim">Loading transactions...</div>}
              {!loading && rows.length === 0 && (
                <div className="p-8">
                  <EmptyState title="No transactions" description="No rows match the current filters." />
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-between">
          <div className="text-sm text-dim">
            Showing {rollup.rows === 0 ? 0 : offset + 1}-{Math.min(offset + rows.length, rollup.rows)} of {rollup.rows}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - limit))}>
              <ChevronLeft className="h-4 w-4" />
              Previous
            </Button>
            <Button variant="outline" disabled={offset + rows.length >= rollup.rows || loading} onClick={() => setOffset(offset + limit)}>
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      <TransactionDrawer
        transaction={selectedTransaction}
        businesses={businesses}
        categories={categories}
        onClose={() => setSelectedTransaction(null)}
        onSaved={() => setRefreshKey((key) => key + 1)}
      />
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label className="font-mono text-[10px] uppercase tracking-wider text-dim">{label}</Label>
      {children}
    </div>
  );
}

function Metric({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'positive' | 'warning' | 'muted';
}) {
  return (
    <div className={cn(
      'rounded-lg border px-3 py-2 shadow-sm',
      tone === 'positive' && 'border-sage/40 bg-sage/10 text-sage-ink',
      tone === 'warning' && 'border-coral/40 bg-coral/10 text-coral-ink',
      tone === 'muted' && 'border-ink2/10 bg-paper text-dim',
      tone === 'default' && 'border-ink2/10 bg-paper',
    )}>
      <div className="font-mono text-[10px] uppercase tracking-wider text-dim">{label}</div>
      <div className="font-display text-xl font-bold tabular-nums">{value}</div>
    </div>
  );
}

function FilterGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      <span className="mr-1 font-mono text-[10px] uppercase tracking-wider text-dim">{label}</span>
      {children}
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
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full border px-2.5 py-1 text-xs font-bold transition-colors',
        active ? 'border-ink bg-ink text-lemon' : 'border-ink2/20 bg-cream/70 text-ink hover:border-ink2/40',
        muted && 'opacity-60',
      )}
    >
      {children}
    </button>
  );
}

function ReceiptPill({ status }: { status: ReceiptStatus }) {
  const variant = status === 'missing' ? 'danger' : status === 'matched' ? 'success' : status === 'pending' ? 'warning' : 'muted';
  return <Badge variant={variant}>{status}</Badge>;
}

function toggle<T>(value: T, values: T[]): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaultFrom(): string {
  const start = new Date();
  start.setMonth(start.getMonth() - 12);
  return start.toISOString().slice(0, 10);
}

const emptyRollup: TransactionRollup = {
  rows: 0,
  inflowCents: 0,
  outflowCents: 0,
  operatingOutflowCents: 0,
  transferCents: 0,
  netCents: 0,
  missingReceipts: 0,
};
