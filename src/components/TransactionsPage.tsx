import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowDownRight,
  ArrowUpRight,
  Boxes,
  Calendar,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CreditCard,
  Download,
  Filter,
  Landmark,
  Wallet,
} from 'lucide-react';
import {
  getTransactionRollup,
  listAccounts,
  listBusinesses,
  listCategories,
  listTransactions,
  uploadReceipt,
  waiveMissingReceipts,
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
import { AppShell } from './AppShell';
import { TransactionDrawer } from './TransactionDrawer';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/empty-state';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/cn';

interface Props {
  user?: CurrentUser;
  onViewChange?: (view: AppView) => void;
  onLogout?: () => void;
  initialFilters?: TransactionViewFilters;
}

interface SavedView {
  id: string;
  label: string;
  filter: () => Partial<{ direction: TransactionDirection; receipts: ReceiptStatus[]; range?: 'this-month' }>;
}

const SAVED_VIEWS: SavedView[] = [
  { id: 'all', label: 'All', filter: () => ({ direction: 'all', receipts: [] }) },
  { id: 'needs-receipt', label: 'Needs receipt', filter: () => ({ direction: 'outflow', receipts: ['missing'] }) },
  { id: 'this-month', label: 'This month', filter: () => ({ direction: 'all', receipts: [], range: 'this-month' }) },
  { id: 'large', label: 'Large outflows', filter: () => ({ direction: 'outflow', receipts: [] }) },
  { id: 'inflows', label: 'Inflows', filter: () => ({ direction: 'inflow', receipts: [] }) },
];

const limit = 100;

export function TransactionsPage({ user, onViewChange, onLogout, initialFilters }: Props) {
  const { toast } = useToast();
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [activeView, setActiveView] = useState<string>('all');
  const [business, setBusiness] = useState(initialFilters?.business ?? 'all');
  const [accountIds, setAccountIds] = useState<string[]>(initialFilters?.accountIds ?? []);
  const [categoryName, setCategoryName] = useState(initialFilters?.categories?.[0] ?? 'all');
  const [receipts, setReceipts] = useState<ReceiptStatus[]>(initialFilters?.receipts ?? []);
  const [direction, setDirection] = useState<TransactionDirection>(initialFilters?.direction ?? 'all');
  const [query, setQuery] = useState(initialFilters?.query ?? '');
  const [from, setFrom] = useState(initialFilters?.from ?? defaultFrom());
  const [to, setTo] = useState(initialFilters?.to ?? today());
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<Transaction[]>([]);
  const [rollup, setRollup] = useState<TransactionRollup>(emptyRollup);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null);
  const [railOpen, setRailOpen] = useState(true);
  const [openGroups, setOpenGroups] = useState({
    business: true,
    accounts: true,
    category: true,
    receipt: false,
  });
  const [missingOutflowCount, setMissingOutflowCount] = useState(0);
  const [waiveBefore, setWaiveBefore] = useState(ninetyDaysAgo());
  const [waiving, setWaiving] = useState(false);

  useEffect(() => {
    setBusiness(initialFilters?.business ?? 'all');
    setAccountIds(initialFilters?.accountIds ?? []);
    setCategoryName(initialFilters?.categories?.[0] ?? 'all');
    setReceipts(initialFilters?.receipts ?? []);
    setDirection(initialFilters?.direction ?? 'all');
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
      .catch((loadError: Error) => setError(loadError.message));
  }, []);

  useEffect(() => {
    const categoryNames = categoryName === 'all' ? [] : [categoryName];
    setLoading(true);
    setError('');
    const sortKey = activeView === 'large' ? 'largest' : 'date';
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
        sort: sortKey,
        dir: 'desc',
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
  }, [accountIds, activeView, business, categoryName, direction, from, offset, query, receipts, refreshKey, to]);

  // Independently track "needs receipt" count so the saved-view badge stays live.
  useEffect(() => {
    getTransactionRollup({ from, to, direction: 'outflow', receipts: ['missing'] })
      .then((summary) => setMissingOutflowCount(summary.rows))
      .catch(() => setMissingOutflowCount(0));
  }, [from, to, refreshKey]);

  const handleWaiveOld = async () => {
    if (!waiveBefore) return;
    setWaiving(true);
    try {
      const result = await waiveMissingReceipts(waiveBefore);
      toast({
        variant: 'success',
        title: `Waived ${result.waived} receipt${result.waived === 1 ? '' : 's'}`,
        description: `Spend before ${waiveBefore} is no longer flagged as missing.`,
      });
      setRefreshKey((key) => key + 1);
    } catch (waiveError) {
      toast({
        variant: 'destructive',
        title: 'Could not waive receipts',
        description: waiveError instanceof Error ? waiveError.message : 'Try again.',
      });
    } finally {
      setWaiving(false);
    }
  };

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

  const applySavedView = (viewId: string) => {
    const view = SAVED_VIEWS.find((v) => v.id === viewId);
    if (!view) return;
    setActiveView(viewId);
    const filter = view.filter();
    setDirection(filter.direction ?? 'all');
    setReceipts(filter.receipts ?? []);
    if (filter.range === 'this-month') {
      setFrom(startOfMonth());
      setTo(today());
    }
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

  const exportCsv = () => {
    const headers = ['date', 'merchant', 'business', 'account', 'category', 'amount', 'receipt'];
    const lines = [headers.join(',')];
    rows.forEach((tx) => {
      const biz = businessById.get(tx.biz)?.name ?? tx.biz;
      const acct = tx.accountId ? accountById.get(tx.accountId) : undefined;
      lines.push([
        tx.date,
        csvEscape(tx.merchant),
        csvEscape(biz),
        csvEscape(acct ? accountLabel(acct) : tx.src),
        csvEscape(tx.cat),
        tx.amount.toFixed(2),
        tx.receipt,
      ].join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `transactions-${from}-to-${to}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const toggleGroup = (key: keyof typeof openGroups) => setOpenGroups((g) => ({ ...g, [key]: !g[key] }));
  const activeViewLabel = SAVED_VIEWS.find((v) => v.id === activeView)?.label ?? 'All';

  return (
    <AppShell
      currentView="transactions"
      onViewChange={onViewChange}
      onLogout={onLogout}
      user={user}
      onUploadReceipt={handleUpload}
      contextEyebrow="Workspace"
      contextTitle="Transactions"
      search={{ query, onQueryChange: (value) => { setQuery(value); setOffset(0); }, placeholder: 'Search merchants…' }}
      businesses={businesses}
      selectedBusiness={business}
      onBusinessChange={(value) => {
        setBusiness(value);
        setAccountIds([]);
        setOffset(0);
      }}
    >
      <div className="flex flex-col gap-3">
        {/* Saved view tabs */}
        <div className="flex items-center gap-1 overflow-x-auto rounded-xl border border-ink2/10 bg-paper p-1.5 shadow-sm">
          {SAVED_VIEWS.map((view) => {
            const active = activeView === view.id;
            const badge = view.id === 'needs-receipt' ? missingOutflowCount : undefined;
            return (
              <button
                key={view.id}
                type="button"
                onClick={() => applySavedView(view.id)}
                className={cn(
                  'inline-flex h-8 shrink-0 items-center gap-2 rounded-lg px-3 text-xs font-bold transition-colors',
                  active ? 'bg-inverse text-inverse-foreground' : 'text-ink hover:bg-cream',
                )}
              >
                {view.label}
                {badge !== undefined && badge > 0 && (
                  <span className={cn(
                    'rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none',
                    active ? 'bg-inverse-foreground text-inverse' : 'bg-coral/20 text-coral-ink',
                  )}>
                    {badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Page header */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">
              Saved view
            </div>
            <h1 className="font-display text-3xl font-bold tracking-tight">{activeViewLabel}</h1>
            <div className="mt-1 text-sm text-dim">
              {rollup.rows} txns · {fmt$(rollup.operatingOutflowCents / 100)} out / {fmt$(rollup.operatingInflowCents / 100)} in
              {rollup.transferCents > 0 && ` · ${fmt$(rollup.transferCents / 100)} transfers (excluded)`}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <DateRangePill from={from} to={to} onChange={({ from: f, to: t }) => { setFrom(f); setTo(t); setOffset(0); }} />
            <Button variant="outline" size="sm" onClick={exportCsv}>
              <Download className="h-3.5 w-3.5" />
              Export
            </Button>
          </div>
        </div>

        {/* Body: rail + content */}
        <div className="flex gap-3">
          {railOpen ? (
            <aside className="hidden w-[240px] shrink-0 rounded-xl border border-ink2/10 bg-paper p-3 shadow-sm lg:block">
              <div className="mb-2 flex items-center justify-between">
                <div className="font-mono text-[10px] font-medium uppercase tracking-wider text-dim">Filters</div>
                <button
                  type="button"
                  onClick={() => setRailOpen(false)}
                  className="text-dim hover:text-ink"
                  title="Collapse"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
              </div>

              <FacetGroup label="Direction" open onToggle={undefined}>
                <div className="grid grid-cols-2 gap-1">
                  {([
                    { value: 'all', label: 'All' },
                    { value: 'outflow', label: 'Out' },
                    { value: 'inflow', label: 'In' },
                    { value: 'transfer', label: 'Transfer' },
                  ] as const).map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => { setDirection(opt.value); setOffset(0); }}
                      className={cn(
                        'rounded-md px-2 py-1 text-xs font-bold transition-colors',
                        direction === opt.value ? 'bg-inverse text-inverse-foreground' : 'bg-cream/40 text-ink hover:bg-cream',
                      )}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </FacetGroup>

              <FacetGroup
                label={`Accounts${accountIds.length ? ` · ${accountIds.length}` : ''}`}
                open={openGroups.accounts}
                onToggle={() => toggleGroup('accounts')}
              >
                <div className="max-h-48 overflow-y-auto">
                  {visibleAccounts.length === 0 && (
                    <div className="px-2 text-xs text-dim">No accounts</div>
                  )}
                  {visibleAccounts.map((account) => {
                    const checked = accountIds.includes(account.id);
                    return (
                      <button
                        key={account.id}
                        type="button"
                        onClick={() => {
                          setAccountIds((current) => toggle(account.id, current));
                          setOffset(0);
                        }}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-cream/60',
                          !account.enabled && 'opacity-60',
                        )}
                      >
                        <span className={cn(
                          'flex h-3.5 w-3.5 items-center justify-center rounded border',
                          checked ? 'border-inverse bg-inverse text-inverse-foreground' : 'border-ink2/25',
                        )}>
                          {checked && <Check className="h-2.5 w-2.5" />}
                        </span>
                        <AccountTypeIcon kind={account.kind} className="h-3 w-3 text-dim" />
                        <span className="flex-1 truncate font-medium text-ink">{accountLabel(account)}</span>
                        {account.mask && (
                          <span className="font-mono text-[10px] text-dim">·{account.mask}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </FacetGroup>

              <FacetGroup
                label="Category"
                open={openGroups.category}
                onToggle={() => toggleGroup('category')}
              >
                <div className="max-h-48 overflow-y-auto">
                  <button
                    type="button"
                    onClick={() => { setCategoryName('all'); setOffset(0); }}
                    className={cn(
                      'flex w-full items-center justify-between rounded-md px-2 py-1 text-xs font-medium transition-colors',
                      categoryName === 'all' ? 'bg-cream text-ink' : 'text-ink hover:bg-cream/60',
                    )}
                  >
                    All
                    {categoryName === 'all' && <Check className="h-3 w-3" />}
                  </button>
                  {categoryOptions.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => { setCategoryName(name); setOffset(0); }}
                      className={cn(
                        'flex w-full items-center justify-between rounded-md px-2 py-1 text-xs font-medium transition-colors',
                        categoryName === name ? 'bg-cream text-ink' : 'text-ink hover:bg-cream/60',
                      )}
                    >
                      <span className="truncate">{name}</span>
                      {categoryName === name && <Check className="h-3 w-3 shrink-0" />}
                    </button>
                  ))}
                </div>
              </FacetGroup>

              <FacetGroup
                label="Receipt status"
                open={openGroups.receipt}
                onToggle={() => toggleGroup('receipt')}
              >
                <div className="grid grid-cols-2 gap-1">
                  {(['missing', 'pending', 'matched', 'n/a', 'waived'] as const).map((status) => (
                    <button
                      key={status}
                      type="button"
                      onClick={() => {
                        setReceipts((current) => toggle(status, current));
                        setOffset(0);
                      }}
                      className={cn(
                        'rounded-md px-2 py-1 text-xs font-bold transition-colors',
                        receipts.includes(status)
                          ? 'bg-inverse text-inverse-foreground'
                          : 'bg-cream/40 text-ink hover:bg-cream',
                      )}
                    >
                      {status}
                    </button>
                  ))}
                </div>

                <div className="mt-3 border-t border-ink2/10 pt-3">
                  <div className="font-mono text-[10px] font-medium uppercase tracking-wider text-dim">
                    Waive old receipts
                  </div>
                  <p className="mt-1 text-[11px] leading-snug text-dim">
                    Mark spend before this date as not needing a receipt (e.g. history pulled before
                    you started collecting receipts).
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <Input
                      type="date"
                      value={waiveBefore}
                      max={today()}
                      onChange={(event) => setWaiveBefore(event.target.value)}
                      className="h-8 flex-1 text-xs"
                    />
                    <Button size="sm" variant="outline" disabled={waiving || !waiveBefore} onClick={handleWaiveOld}>
                      {waiving ? 'Waiving…' : 'Waive'}
                    </Button>
                  </div>
                </div>
              </FacetGroup>
            </aside>
          ) : (
            <div className="hidden lg:block">
              <Button variant="outline" size="sm" onClick={() => setRailOpen(true)}>
                <Filter className="h-3.5 w-3.5" />
                Filters
              </Button>
            </div>
          )}

          <div className="min-w-0 flex-1">
            <div className="mb-3 grid gap-3 sm:grid-cols-3">
              <Metric
                label="Inflow"
                value={fmt$(rollup.operatingInflowCents / 100)}
                tone="positive"
                detail={rollup.transferCents > 0 ? 'Excludes transfers' : 'Cash received'}
                icon={<ArrowDownRight className="h-3.5 w-3.5" />}
              />
              <Metric
                label="Outflow"
                value={fmt$(rollup.operatingOutflowCents / 100)}
                detail={rollup.transferCents > 0 ? 'Excludes transfers' : 'Operating spend'}
                icon={<ArrowUpRight className="h-3.5 w-3.5 text-dim" />}
              />
              <Metric
                label="Net"
                value={fmt$((rollup.operatingInflowCents - rollup.operatingOutflowCents) / 100)}
                tone={rollup.operatingInflowCents - rollup.operatingOutflowCents >= 0 ? 'positive' : 'warning'}
                detail={rollup.missingReceipts ? `${rollup.missingReceipts} missing receipts` : 'All receipts matched'}
              />
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
                          <TableRow
                            key={transaction.id}
                            onClick={() => setSelectedTransaction(transaction)}
                            className="cursor-pointer"
                          >
                            <TableCell className="whitespace-nowrap text-dim">
                              <div className="font-mono text-[11px]">{transaction.date}</div>
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                {transaction.amount > 0 ? (
                                  <ArrowDownRight className="h-3.5 w-3.5 shrink-0 text-sage-ink" />
                                ) : (
                                  <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-dim" />
                                )}
                                <div className="min-w-0">
                                  <div className="truncate font-bold text-ink" title={transaction.merchant}>
                                    {transaction.merchant}
                                  </div>
                                  {transaction.note && (
                                    <div className="truncate text-[11px] text-dim">{transaction.note}</div>
                                  )}
                                </div>
                              </div>
                            </TableCell>
                            <TableCell className="truncate">
                              <span className="inline-flex items-center gap-1.5 text-xs">
                                <span
                                  className="h-1.5 w-1.5 rounded-full"
                                  style={{ background: rowBusiness?.color ?? '#ccc' }}
                                />
                                <span className="text-dim">{rowBusiness?.name ?? transaction.biz}</span>
                              </span>
                            </TableCell>
                            <TableCell className="truncate text-dim">
                              {account ? (
                                <span className="inline-flex items-center gap-1.5">
                                  <AccountTypeIcon kind={account.kind} className="h-3 w-3" />
                                  <span className="truncate text-xs">{accountLabel(account)}</span>
                                </span>
                              ) : (
                                <span className="text-xs">{transaction.src}</span>
                              )}
                            </TableCell>
                            <TableCell className="truncate text-xs">{transaction.cat}</TableCell>
                            <TableCell
                              className={cn(
                                'text-right font-display font-bold tabular-nums',
                                transaction.amount > 0 ? 'text-sage-ink' : 'text-ink',
                              )}
                            >
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
                  {loading && <div className="p-6 text-center text-sm text-dim">Loading transactions...</div>}
                  {!loading && rows.length === 0 && (
                    <div className="p-8">
                      <EmptyState title="No transactions" description="No rows match the current filters." />
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="mt-3 flex items-center justify-between text-xs text-dim">
              <div>
                Showing {rollup.rows === 0 ? 0 : offset + 1}–{Math.min(offset + rows.length, rollup.rows)} of {rollup.rows}
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset === 0 || loading}
                  onClick={() => setOffset(Math.max(0, offset - limit))}
                >
                  <ChevronLeft className="h-3 w-3" />
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset + rows.length >= rollup.rows || loading}
                  onClick={() => setOffset(offset + limit)}
                >
                  Next
                  <ChevronRight className="h-3 w-3" />
                </Button>
              </div>
            </div>
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
    </AppShell>
  );
}

function FacetGroup({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open?: boolean;
  onToggle?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="border-t border-ink2/8 py-2 first:border-t-0 first:pt-0">
      <button
        type="button"
        onClick={onToggle}
        disabled={!onToggle}
        className="mb-1.5 flex w-full items-center justify-between font-mono text-[10px] font-medium uppercase tracking-wider text-dim hover:text-ink"
      >
        <span>{label}</span>
        {onToggle && (open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}
      </button>
      {open !== false && children}
    </div>
  );
}

function Metric({
  label,
  value,
  tone = 'default',
  detail,
  icon,
}: {
  label: string;
  value: string;
  tone?: 'default' | 'positive' | 'warning' | 'muted';
  detail?: string;
  icon?: ReactNode;
}) {
  return (
    <div
      className={cn(
        'rounded-xl border px-4 py-3 shadow-sm',
        tone === 'positive' && 'border-sage/40 bg-sage/10 text-sage-ink',
        tone === 'warning' && 'border-coral/40 bg-coral/10 text-coral-ink',
        tone === 'muted' && 'border-ink2/10 bg-paper text-dim',
        tone === 'default' && 'border-ink2/10 bg-paper',
      )}
    >
      <div className="flex items-center justify-between">
        <div className="font-mono text-[10px] uppercase tracking-wider text-dim">{label}</div>
        {icon}
      </div>
      <div className="mt-1 font-display text-xl font-bold tabular-nums">{value}</div>
      {detail && <div className="mt-1 truncate text-xs font-medium text-dim">{detail}</div>}
    </div>
  );
}

function ReceiptPill({ status }: { status: ReceiptStatus }) {
  const variant =
    status === 'missing'
      ? 'danger'
      : status === 'matched'
        ? 'success'
        : status === 'pending'
          ? 'warning'
          : 'muted';
  return <Badge variant={variant}>{status}</Badge>;
}

function AccountTypeIcon({ kind, className }: { kind: Account['kind']; className?: string }) {
  if (kind === 'credit') return <CreditCard className={className} />;
  if (kind === 'savings') return <Wallet className={className} />;
  if (kind === 'checking') return <Landmark className={className} />;
  return <Boxes className={className} />;
}

function DateRangePill({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (range: { from: string; to: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const presets = useMemo(() => {
    const t = today();
    return [
      { label: 'Last 7 days', from: shiftDays(t, -7), to: t },
      { label: 'Last 30 days', from: shiftDays(t, -30), to: t },
      { label: 'This month', from: startOfMonth(), to: t },
      { label: 'Last 90 days', from: shiftDays(t, -90), to: t },
      { label: 'YTD', from: `${t.slice(0, 4)}-01-01`, to: t },
      { label: 'Last 12 months', from: shiftMonths(t, -12), to: t },
    ];
  }, []);
  const matched = presets.find((p) => p.from === from && p.to === to);
  const label = matched ? matched.label : `${from} → ${to}`;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-9 items-center gap-2 rounded-full border border-ink2/15 bg-paper px-3 text-xs font-bold text-ink hover:border-ink2/30"
      >
        <Calendar className="h-3.5 w-3.5 text-dim" />
        {label}
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-40 mt-1 w-[280px] rounded-xl border border-ink2/10 bg-paper p-2 shadow-lg">
            {presets.map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => {
                  onChange({ from: preset.from, to: preset.to });
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs font-bold transition-colors',
                  from === preset.from && to === preset.to ? 'bg-cream' : 'hover:bg-cream',
                )}
              >
                <span>{preset.label}</span>
                <span className="font-mono text-[10px] text-dim">
                  {preset.from.slice(5)} → {preset.to.slice(5)}
                </span>
              </button>
            ))}
            <div className="mt-2 grid grid-cols-2 gap-2 border-t border-ink2/10 pt-2">
              <label className="grid gap-1">
                <span className="font-mono text-[10px] uppercase tracking-wider text-dim">From</span>
                <input
                  type="date"
                  value={from}
                  onChange={(event) => onChange({ from: event.target.value, to })}
                  className="h-8 rounded-md border border-ink2/10 bg-paper px-2 text-xs"
                />
              </label>
              <label className="grid gap-1">
                <span className="font-mono text-[10px] uppercase tracking-wider text-dim">To</span>
                <input
                  type="date"
                  value={to}
                  onChange={(event) => onChange({ from, to: event.target.value })}
                  className="h-8 rounded-md border border-ink2/10 bg-paper px-2 text-xs"
                />
              </label>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function toggle<T>(value: T, values: T[]): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function startOfMonth(): string {
  return `${new Date().toISOString().slice(0, 7)}-01`;
}

function ninetyDaysAgo(): string {
  const date = new Date();
  date.setDate(date.getDate() - 90);
  return date.toISOString().slice(0, 10);
}

function shiftDays(value: string, delta: number): string {
  const date = new Date(`${value}T00:00:00`);
  date.setDate(date.getDate() + delta);
  return date.toISOString().slice(0, 10);
}

function shiftMonths(value: string, delta: number): string {
  const date = new Date(`${value}T00:00:00`);
  date.setMonth(date.getMonth() + delta);
  return date.toISOString().slice(0, 10);
}

function defaultFrom(): string {
  return shiftMonths(today(), -12);
}

const emptyRollup: TransactionRollup = {
  rows: 0,
  inflowCents: 0,
  outflowCents: 0,
  operatingInflowCents: 0,
  operatingOutflowCents: 0,
  transferCents: 0,
  netCents: 0,
  missingReceipts: 0,
};
