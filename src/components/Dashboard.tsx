import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { Business, CurrentUser, Transaction } from '@/types/domain';
import type { AppView, TransactionViewFilters } from '@/types/navigation';
import { countDuplicateSubs, countNeedsReceipt } from '@/lib/calc';
import { clearDashboardCache, useDashboard } from '@/hooks/useDashboard';
import { uploadReceipt } from '@/api';
import { useToast } from '@/hooks/useToast';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Input } from '@/components/ui/input';
import { HeaderBar } from './HeaderBar';
import { BusinessStrip } from './BusinessStrip';
import { SpendHeroTile, type DashboardFlowMode } from './tiles/SpendHeroTile';
import { ReceiptDropTile } from './tiles/ReceiptDropTile';
import { ActivityTile } from './tiles/ActivityTile';
import { CategoriesTile } from './tiles/CategoriesTile';
import { ConnectionsTile } from './tiles/ConnectionsTile';
import { AlertsTile } from './tiles/AlertsTile';
import { AccountSpendTile } from './tiles/AccountSpendTile';
import { AnalysisTile } from './tiles/AnalysisTile';
import { ConnectionsManager } from './ConnectionsManager';
import { CategorizationReviewCenter } from './CategorizationReviewCenter';
import { TransactionDrawer } from './TransactionDrawer';

type TimePreset = 'month' | 'last3' | 'last12' | 'ytd';

function captionFor(biz: Business, txns: Transaction[]): string {
  const total = txns.filter((t) => t.biz === biz.id).length;
  const missing = countNeedsReceipt(txns, biz.id);
  const dup = countDuplicateSubs(txns, biz.id);
  if (dup > 0) return `${total} txns · ${dup} dup sub`;
  if (missing > 0) return `${total} txns · ${missing} needs receipt`;
  return `${total} txns`;
}

interface DashboardProps {
  onViewChange?: (view: AppView) => void;
  onOpenTransactions?: (filters: TransactionViewFilters) => void;
  onLogout?: () => void;
  user?: CurrentUser;
}

export function Dashboard({ onViewChange, onOpenTransactions, onLogout, user }: DashboardProps) {
  const { toast } = useToast();
  const [businessFilter, setBusinessFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [anchorMonth, setAnchorMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [timePreset, setTimePreset] = useState<TimePreset>('month');
  const [comparisonBasis, setComparisonBasis] = useState<'month' | 'year'>('month');
  const [dashboardFlowMode, setDashboardFlowMode] = useState<DashboardFlowMode>('outflow');
  const [refreshKey, setRefreshKey] = useState(0);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [reviewCenterOpen, setReviewCenterOpen] = useState(false);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null);
  const [receiptStatus, setReceiptStatus] = useState<{
    state: 'idle' | 'uploading' | 'processing' | 'matched' | 'pending' | 'error';
    message?: string;
  }>({ state: 'idle' });

  const timeWindow = buildTimeWindow(anchorMonth, timePreset);
  const { data, loading, error } = useDashboard({
    business: businessFilter,
    query,
    refreshKey,
    comparisonBasis,
    accountIds: selectedAccountIds,
    period: anchorMonth,
    from: timeWindow.from,
    to: timeWindow.to,
    label: timeWindow.label,
  });

  useEffect(() => {
    if (!data) return;
    const available = new Set(data.accounts.map((account) => account.id));
    setSelectedAccountIds((current) => {
      const next = current.filter((accountId) => available.has(accountId));
      return next.length === current.length ? current : next;
    });
  }, [data]);

  if (error) return <StateScreen tone="error">Couldn't load: {error.message}</StateScreen>;
  if (loading || !data) return <StateScreen>Loading…</StateScreen>;

  const {
    businesses,
    transactions,
    categories,
    categoryComparisons,
    connections,
    accounts,
    alerts,
    categorizationReviewItems,
    summary,
  } = data;
  const selectedBusiness = businesses.find((business) => business.id === businessFilter);
  const selectedBusinessDbId = businessFilter === 'all' ? undefined : selectedBusiness?.dbId;
  const heroContext = selectedAccountIds.length
    ? `filtered to ${selectedAccountIds.length} account${selectedAccountIds.length === 1 ? '' : 's'}`
    : selectedBusiness
      ? `for ${selectedBusiness.name}`
      : 'across watched accounts';
  const watchedCount = accounts.filter((account) => account.enabled).length;
  const ignoredCount = accounts.length - watchedCount;
  const heroDetail = ignoredCount > 0
    ? `${watchedCount} watched · ${ignoredCount} ignored`
    : `${watchedCount} watched account${watchedCount === 1 ? '' : 's'}`;

  const handleUpload = async (file: File) => {
    setReceiptStatus({ state: 'uploading', message: file.name });
    try {
      const result = await uploadReceipt(file, selectedBusinessDbId);
      setReceiptStatus({
        state: result.matched ? 'matched' : result.processing ? 'processing' : 'pending',
        message: result.matched ? `Matched ${result.matched.merchant}` : 'OCR and matching job queued.',
      });
      toast({
        variant: result.matched ? 'success' : 'default',
        title: result.matched ? 'Receipt matched' : 'Receipt queued',
        description: result.matched ? `Matched ${result.matched.merchant}.` : 'OCR and matching job queued.',
      });
      refreshDashboard();
    } catch (uploadError) {
      const message = uploadError instanceof Error ? uploadError.message : 'Upload failed.';
      setReceiptStatus({ state: 'error', message });
      toast({ variant: 'destructive', title: 'Upload failed', description: message });
    }
  };
  const handleBusinessChange = (business: string) => {
    setBusinessFilter(business);
    setSelectedAccountIds([]);
  };
  const toggleAccountFilter = (accountId: string) => {
    setSelectedAccountIds((current) => (
      current.includes(accountId)
        ? current.filter((id) => id !== accountId)
        : [...current, accountId]
    ));
  };
  const openTransactions = () => {
    onOpenTransactions?.({
      business: businessFilter,
      accountIds: selectedAccountIds,
      query,
      from: timeWindow.from,
      to: timeWindow.to,
    });
  };
  const refreshDashboard = () => {
    clearDashboardCache();
    setRefreshKey((key) => key + 1);
  };

  return (
    <div className="min-h-screen bg-bg text-ink">
      <div className="mx-auto flex max-w-[1600px] flex-col gap-4 p-4">
        <HeaderBar
          onUploadReceipt={handleUpload}
          currentView="dashboard"
          onViewChange={onViewChange}
          onLogout={onLogout}
          user={user}
          businesses={businesses}
          selectedBusiness={businessFilter}
          onBusinessChange={handleBusinessChange}
          query={query}
          onQueryChange={setQuery}
          reviewCount={categorizationReviewItems.length}
          onOpenReviewCenter={() => setReviewCenterOpen(true)}
        />

        <BusinessStrip
          businesses={businesses}
          transactions={transactions}
          selected={businessFilter}
          onSelect={handleBusinessChange}
          captionFor={(business) => captionFor(business, transactions)}
        />

        <TimeframeControls
          month={anchorMonth}
          preset={timePreset}
          label={timeWindow.display}
          onMonthChange={setAnchorMonth}
          onPresetChange={setTimePreset}
        />

        <div
          className="grid grid-cols-12 gap-3"
          style={{ gridAutoRows: '164px' }}
        >
          <SpendHeroTile
            summary={summary}
            contextLabel={heroContext}
            detailLabel={heroDetail}
            mode={dashboardFlowMode}
            onModeChange={setDashboardFlowMode}
          />
          <AlertsTile alerts={alerts} />
          <ConnectionsTile connections={connections} onAdd={() => setConnectionsOpen(true)} />

          <CategoriesTile
            categories={categories}
            comparisons={categoryComparisons}
            comparisonBasis={comparisonBasis}
            onComparisonBasisChange={setComparisonBasis}
          />
          <AnalysisTile
            businesses={businesses}
            accounts={accounts}
            transactions={transactions}
            onOpenTransactions={openTransactions}
          />

          <ActivityTile
            transactions={transactions}
            businesses={businesses}
            totalCount={transactions.length}
            onSelect={setSelectedTransaction}
            onViewAll={openTransactions}
          />
          <ReceiptDropTile onFile={handleUpload} status={receiptStatus} />

          <AccountSpendTile
            accounts={accounts}
            businesses={businesses}
            transactions={transactions}
            selectedAccountIds={selectedAccountIds}
            onToggleAccount={toggleAccountFilter}
            onClearAccounts={() => setSelectedAccountIds([])}
            onManageAccounts={() => setConnectionsOpen(true)}
          />
        </div>
      </div>

      <ConnectionsManager
        open={connectionsOpen}
        businesses={businesses}
        connections={connections}
        accounts={accounts}
        onClose={() => setConnectionsOpen(false)}
        onRefresh={refreshDashboard}
      />
      <CategorizationReviewCenter
        open={reviewCenterOpen}
        items={categorizationReviewItems}
        businesses={businesses}
        onClose={() => setReviewCenterOpen(false)}
        onResolved={refreshDashboard}
      />
      <TransactionDrawer
        transaction={selectedTransaction}
        businesses={businesses}
        categories={categories}
        onClose={() => setSelectedTransaction(null)}
        onSaved={refreshDashboard}
      />
    </div>
  );
}

function TimeframeControls({
  month,
  preset,
  label,
  onMonthChange,
  onPresetChange,
}: {
  month: string;
  preset: TimePreset;
  label: string;
  onMonthChange: (month: string) => void;
  onPresetChange: (preset: TimePreset) => void;
}) {
  const shiftMonth = (delta: number) => {
    const current = new Date(`${month}-01T00:00:00`);
    current.setMonth(current.getMonth() + delta);
    onMonthChange(current.toISOString().slice(0, 7));
  };

  return (
    <div className="flex flex-wrap items-center gap-3 px-1">
      <div className="flex items-center gap-1.5 rounded-full bg-paper p-1 shadow-xs">
        <Button variant="ghost" size="icon-sm" onClick={() => shiftMonth(-1)} title="Previous month">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Input
          type="month"
          value={month}
          onChange={(event) => onMonthChange(event.target.value)}
          className="h-7 w-auto rounded-full border-transparent bg-transparent px-2 text-xs font-bold focus-visible:bg-cream"
        />
        <Button variant="ghost" size="icon-sm" onClick={() => shiftMonth(1)} title="Next month">
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
      <ToggleGroup
        type="single"
        value={preset}
        onValueChange={(value) => value && onPresetChange(value as TimePreset)}
      >
        <ToggleGroupItem value="month">Month</ToggleGroupItem>
        <ToggleGroupItem value="last3">Last 3m</ToggleGroupItem>
        <ToggleGroupItem value="last12">Last 12m</ToggleGroupItem>
        <ToggleGroupItem value="ytd">YTD</ToggleGroupItem>
      </ToggleGroup>
      <span className="text-xs text-dim">{label}</span>
    </div>
  );
}

function buildTimeWindow(month: string, preset: TimePreset) {
  const start = new Date(`${month}-01T00:00:00`);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
  let fromDate = new Date(start);
  let label = start.toLocaleString('en-US', { month: 'short' }).toUpperCase();
  let display = start.toLocaleString('en-US', { month: 'long', year: 'numeric' });

  if (preset === 'last3') {
    fromDate = new Date(start.getFullYear(), start.getMonth() - 2, 1);
    label = 'LAST 3M';
    display = `${formatRangeMonth(fromDate)} - ${formatRangeMonth(end)}`;
  } else if (preset === 'last12') {
    fromDate = new Date(start.getFullYear(), start.getMonth() - 11, 1);
    label = 'LAST 12M';
    display = `${formatRangeMonth(fromDate)} - ${formatRangeMonth(end)}`;
  } else if (preset === 'ytd') {
    fromDate = new Date(start.getFullYear(), 0, 1);
    label = 'YTD';
    display = `${start.getFullYear()} year to date`;
  }

  return {
    from: isoDate(fromDate),
    to: isoDate(end),
    label,
    display,
  };
}

function formatRangeMonth(date: Date): string {
  return date.toLocaleString('en-US', { month: 'short', year: 'numeric' });
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function StateScreen({ children, tone }: { children: React.ReactNode; tone?: 'error' }) {
  return (
    <div className={`flex min-h-screen items-center justify-center bg-bg text-sm ${tone === 'error' ? 'text-coral-ink' : 'text-dim'}`}>
      {children}
    </div>
  );
}
