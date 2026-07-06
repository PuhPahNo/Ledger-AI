import { useEffect, useMemo, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Download } from 'lucide-react';
import {
  bulkCategorizeTransactions,
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
import {
  DateRangePill,
  Metric,
  csvEscape,
  defaultFrom,
  emptyRollup,
  ninetyDaysAgo,
  startOfMonth,
  today,
  toggle,
} from './transactions/TransactionPageParts';
import { TransactionsFilterRail } from './transactions/TransactionsFilterRail';
import { TransactionsTable } from './transactions/TransactionsTable';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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
    accounts: true,
    category: true,
    receipt: false,
  });
  const [missingOutflowCount, setMissingOutflowCount] = useState(0);
  const [waiveBefore, setWaiveBefore] = useState(ninetyDaysAgo());
  const [waiving, setWaiving] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkCategoryId, setBulkCategoryId] = useState('');
  const [bulkApplying, setBulkApplying] = useState(false);

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
        setSelectedIds(new Set());
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

  const toggleSelect = (transactionId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(transactionId)) next.delete(transactionId);
      else next.add(transactionId);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedIds((current) => (
      rows.length > 0 && rows.every((row) => current.has(row.id))
        ? new Set()
        : new Set(rows.map((row) => row.id))
    ));
  };

  const bulkCategoryOptions = useMemo(
    () => categories.filter((category) => category.id),
    [categories],
  );

  const handleBulkCategorize = async () => {
    if (!bulkCategoryId || selectedIds.size === 0) return;
    setBulkApplying(true);
    try {
      const result = await bulkCategorizeTransactions([...selectedIds], bulkCategoryId);
      toast({
        variant: 'success',
        title: `Categorized ${result.updated} transaction${result.updated === 1 ? '' : 's'}`,
        description: result.skipped > 0 ? `${result.skipped} skipped (already set or wrong direction).` : undefined,
      });
      setSelectedIds(new Set());
      setBulkCategoryId('');
      setRefreshKey((key) => key + 1);
    } catch (bulkError) {
      toast({
        variant: 'destructive',
        title: 'Bulk categorize failed',
        description: bulkError instanceof Error ? bulkError.message : 'Try again.',
      });
    } finally {
      setBulkApplying(false);
    }
  };

  const resetToFirstPage = () => setOffset(0);
  const setFilterDirection = (value: TransactionDirection) => {
    setDirection(value);
    resetToFirstPage();
  };
  const toggleAccountFilter = (accountId: string) => {
    setAccountIds((current) => toggle(accountId, current));
    resetToFirstPage();
  };
  const setCategoryFilter = (name: string) => {
    setCategoryName(name);
    resetToFirstPage();
  };
  const toggleReceiptFilter = (status: ReceiptStatus) => {
    setReceipts((current) => toggle(status, current));
    resetToFirstPage();
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
          <TransactionsFilterRail
            railOpen={railOpen}
            direction={direction}
            visibleAccounts={visibleAccounts}
            accountIds={accountIds}
            categoryName={categoryName}
            categoryOptions={categoryOptions}
            receipts={receipts}
            openGroups={openGroups}
            waiveBefore={waiveBefore}
            waiving={waiving}
            onRailOpenChange={setRailOpen}
            onDirectionChange={setFilterDirection}
            onAccountToggle={toggleAccountFilter}
            onCategoryChange={setCategoryFilter}
            onReceiptToggle={toggleReceiptFilter}
            onToggleGroup={toggleGroup}
            onWaiveBeforeChange={setWaiveBefore}
            onWaiveOld={handleWaiveOld}
          />

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

            {selectedIds.size > 0 && (
              <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-ink2/10 bg-paper px-3 py-2 shadow-sm">
                <span className="text-xs font-bold">{selectedIds.size} selected</span>
                <Select value={bulkCategoryId || undefined} onValueChange={setBulkCategoryId}>
                  <SelectTrigger className="h-8 w-56 text-xs">
                    <SelectValue placeholder="Set category to…" />
                  </SelectTrigger>
                  <SelectContent>
                    {bulkCategoryOptions.map((category) => (
                      <SelectItem key={category.id} value={category.id!}>{category.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button size="sm" disabled={!bulkCategoryId || bulkApplying} onClick={handleBulkCategorize}>
                  {bulkApplying ? 'Applying…' : 'Apply category'}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set())}>
                  Clear
                </Button>
              </div>
            )}

            <TransactionsTable
              rows={rows}
              rollup={rollup}
              offset={offset}
              limit={limit}
              loading={loading}
              error={error}
              businessById={businessById}
              accountById={accountById}
              onSelectTransaction={setSelectedTransaction}
              onPageChange={setOffset}
              selectedIds={selectedIds}
              onToggleSelect={toggleSelect}
              onToggleSelectAll={toggleSelectAll}
            />
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
