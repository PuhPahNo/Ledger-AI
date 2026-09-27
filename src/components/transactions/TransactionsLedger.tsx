import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Download } from 'lucide-react';
import {
  bulkCategorizeTransactions,
  getTransactionRollup,
  listAccounts,
  listBusinesses,
  listCategories,
  listTags,
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
  Tag,
  Transaction,
  TransactionDirection,
  TransactionRollup,
} from '@/types/domain';
import type { NavigateFn, TransactionViewFilters } from '@/types/navigation';
import { accountLabel } from '@/lib/account';
import { fmt$ } from '@/lib/format';
import { useToast } from '@/hooks/useToast';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { AppShell } from '../AppShell';
import { TransactionDrawer } from '../TransactionDrawer';
import {
  DateRangePill,
  csvEscape,
  defaultFrom,
  emptyRollup,
  ninetyDaysAgo,
  startOfMonth,
  today,
  toggle,
} from './TransactionPageParts';
import { TransactionsFilterRail } from './TransactionsFilterRail';
import { TransactionsTable } from './TransactionsTable';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/cn';

interface Props {
  user?: CurrentUser;
  onViewChange?: NavigateFn;
  onLogout?: () => void;
  initialFilters?: TransactionViewFilters;
  /** The Transactions | Receipts segmented control, rendered above the toolbar. */
  modeSwitch?: ReactNode;
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
  // Sorted biggest-first rather than filtered by a threshold — labelled for what it does.
  { id: 'large', label: 'Largest outflows', filter: () => ({ direction: 'outflow', receipts: [] }) },
  { id: 'inflows', label: 'Inflows', filter: () => ({ direction: 'inflow', receipts: [] }) },
];

const limit = 100;

/** Transactions mode of the Transactions page: saved views, filter rail, table, bulk edit. */
export function TransactionsLedger({ user, onViewChange, onLogout, initialFilters, modeSwitch }: Props) {
  const { toast } = useToast();
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [activeView, setActiveView] = useState<string>('all');
  const [business, setBusiness] = useState(initialFilters?.business ?? 'all');
  const [accountIds, setAccountIds] = useState<string[]>(initialFilters?.accountIds ?? []);
  const [categoryName, setCategoryName] = useState(initialFilters?.categories?.[0] ?? 'all');
  const [receipts, setReceipts] = useState<ReceiptStatus[]>(initialFilters?.receipts ?? []);
  const [tagIds, setTagIds] = useState<string[]>(initialFilters?.tagIds ?? []);
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
    tags: true,
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
    setTagIds(initialFilters?.tagIds ?? []);
    setDirection(initialFilters?.direction ?? 'all');
    setQuery(initialFilters?.query ?? '');
    setFrom(initialFilters?.from ?? defaultFrom());
    setTo(initialFilters?.to ?? today());
    setOffset(0);
  }, [initialFilters]);

  useEffect(() => {
    Promise.all([listBusinesses(), listAccounts(), listCategories(), listTags()])
      .then(([businessRows, accountRows, categoryRows, tagRows]) => {
        setBusinesses(businessRows);
        setAccounts(accountRows);
        setCategories(categoryRows);
        setTags(tagRows);
      })
      .catch((loadError: Error) => setError(loadError.message));
  }, []);

  // Search typing shouldn't fire a request per keystroke.
  const debouncedQuery = useDebouncedValue(query.trim(), 300);
  // Only the latest request may write state; slower stale responses are dropped.
  const requestSeq = useRef(0);

  useEffect(() => {
    const categoryNames = categoryName === 'all' ? [] : [categoryName];
    const requestId = ++requestSeq.current;
    const isCurrent = () => requestSeq.current === requestId;
    setLoading(true);
    setError('');
    const sortKey = activeView === 'large' ? 'largest' : 'date';
    Promise.all([
      listTransactions({
        biz: business,
        accountIds,
        categories: categoryNames,
        receipts,
        tagIds,
        direction,
        q: debouncedQuery || undefined,
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
        tagIds,
        direction,
        q: debouncedQuery || undefined,
        from: from || undefined,
        to: to || undefined,
      }),
    ])
      .then(([transactionRows, summary]) => {
        if (!isCurrent()) return;
        setRows(transactionRows);
        setRollup(summary);
        setSelectedIds(new Set());
      })
      .catch((loadError: Error) => {
        if (isCurrent()) setError(loadError.message);
      })
      .finally(() => {
        if (isCurrent()) setLoading(false);
      });
  }, [accountIds, activeView, business, categoryName, debouncedQuery, direction, from, offset, receipts, refreshKey, tagIds, to]);

  // Independently track the "Needs receipt" count so the saved-view badge stays live. It
  // follows the same business/account scope as the table so the badge matches the view.
  useEffect(() => {
    let cancelled = false;
    getTransactionRollup({ biz: business, accountIds, from, to, direction: 'outflow', receipts: ['missing'] })
      .then((summary) => !cancelled && setMissingOutflowCount(summary.rows))
      .catch(() => !cancelled && setMissingOutflowCount(0));
    return () => {
      cancelled = true;
    };
  }, [accountIds, business, from, to, refreshKey]);

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
  const toggleTagFilter = (tagId: string) => {
    setTagIds((current) => toggle(tagId, current));
    resetToFirstPage();
  };
  const toggleGroup = (key: keyof typeof openGroups) => setOpenGroups((g) => ({ ...g, [key]: !g[key] }));

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
        {modeSwitch}
        {/* Toolbar: saved views + date range + export in one row */}
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-ink2/10 bg-paper p-1.5 shadow-sm">
          <div className="flex items-center gap-1 overflow-x-auto">
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
          <div className="ml-auto flex flex-wrap items-center gap-2">
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
            tags={tags}
            tagIds={tagIds}
            receipts={receipts}
            openGroups={openGroups}
            waiveBefore={waiveBefore}
            waiving={waiving}
            onRailOpenChange={setRailOpen}
            onDirectionChange={setFilterDirection}
            onAccountToggle={toggleAccountFilter}
            onCategoryChange={setCategoryFilter}
            onTagToggle={toggleTagFilter}
            onReceiptToggle={toggleReceiptFilter}
            onToggleGroup={toggleGroup}
            onWaiveBeforeChange={setWaiveBefore}
            onWaiveOld={handleWaiveOld}
          />

          <div className="min-w-0 flex-1">
            <RollupStrip rollup={rollup} />

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
              groupByDate={activeView !== 'large'}
            />
          </div>
        </div>
      </div>

      <TransactionDrawer
        transaction={selectedTransaction}
        businesses={businesses}
        categories={categories}
        allTags={tags}
        onClose={() => setSelectedTransaction(null)}
        onSaved={() => setRefreshKey((key) => key + 1)}
      />
    </AppShell>
  );
}

/**
 * In / out / net for the filtered set — one slim line. Unlike Home's KPIs these follow every
 * filter on the page (account, category, tag, receipt state), which is why they're here.
 */
function RollupStrip({ rollup }: { rollup: TransactionRollup }) {
  const net = rollup.operatingInflowCents - rollup.operatingOutflowCents;
  return (
    <div className="mb-3 flex flex-wrap items-baseline gap-x-5 gap-y-1 rounded-xl border border-ink2/10 bg-paper px-4 py-2 text-sm shadow-sm">
      <StripValue label="In" value={fmt$(rollup.operatingInflowCents / 100)} className="text-sage-ink" />
      <StripValue label="Out" value={fmt$(rollup.operatingOutflowCents / 100)} />
      <StripValue label="Net" value={fmt$(net / 100)} className={net < 0 ? 'text-coral-ink' : 'text-sage-ink'} />
      <span className="text-xs text-dim sm:ml-auto">
        {rollup.transferCents > 0 ? `Excludes ${fmt$(rollup.transferCents / 100)} transfers` : 'Operating cash'}
        {rollup.missingReceipts ? ` · ${rollup.missingReceipts} missing receipt${rollup.missingReceipts === 1 ? '' : 's'}` : ''}
      </span>
    </div>
  );
}

function StripValue({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="font-mono text-[10px] uppercase tracking-wider text-dim">{label}</span>
      <span className={cn('font-display font-bold tabular-nums', className)}>{value}</span>
    </span>
  );
}
