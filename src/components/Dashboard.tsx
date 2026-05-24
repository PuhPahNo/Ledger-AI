import { useEffect, useState } from 'react';
import type { Business, CurrentUser, Transaction } from '@/types/domain';
import { colors, fonts, radii } from '@/theme/tokens';
import { countDuplicateSubs, countNeedsReceipt } from '@/lib/calc';
import { useDashboard } from '@/hooks/useDashboard';
import { uploadReceipt } from '@/api';
import { HeaderBar } from './HeaderBar';
import { SpendHeroTile } from './tiles/SpendHeroTile';
import { BusinessTile } from './tiles/BusinessTile';
import { ReceiptDropTile } from './tiles/ReceiptDropTile';
import { ActivityTile } from './tiles/ActivityTile';
import { CategoriesTile } from './tiles/CategoriesTile';
import { ConnectionsTile } from './tiles/ConnectionsTile';
import { AlertsTile } from './tiles/AlertsTile';
import { AccountSpendTile } from './tiles/AccountSpendTile';
import { AnalysisTile } from './tiles/AnalysisTile';
import { ConnectionsManager } from './ConnectionsManager';
import { TransactionDrawer } from './TransactionDrawer';
import { TransactionExplorer } from './TransactionExplorer';

type TimePreset = 'month' | 'last3' | 'last12' | 'ytd';

/** Display-only caption for a business tile, computed from the loaded transactions. */
function captionFor(biz: Business, txns: Transaction[]): string {
  const total = txns.filter((t) => t.biz === biz.id).length;
  const missing = countNeedsReceipt(txns, biz.id);
  const dup = countDuplicateSubs(txns, biz.id);
  if (dup > 0) return `${total} txns · ${dup} dup sub`;
  if (missing > 0) return `${total} txns · ${missing} needs receipt`;
  return `${total} txns`;
}

interface DashboardProps {
  onViewChange?: (view: 'dashboard' | 'admin') => void;
  onLogout?: () => void;
  user?: CurrentUser;
}

export function Dashboard({ onViewChange, onLogout, user }: DashboardProps) {
  const [businessFilter, setBusinessFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [anchorMonth, setAnchorMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [timePreset, setTimePreset] = useState<TimePreset>('month');
  const [comparisonBasis, setComparisonBasis] = useState<'month' | 'year'>('month');
  const [refreshKey, setRefreshKey] = useState(0);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [transactionsOpen, setTransactionsOpen] = useState(false);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null);
  const [receiptStatus, setReceiptStatus] = useState<{ state: 'idle' | 'uploading' | 'processing' | 'matched' | 'pending' | 'error'; message?: string }>({ state: 'idle' });
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

  const { businesses, transactions, categories, categoryComparisons, connections, accounts, alerts, summary } = data;
  const selectedBusiness = businesses.find((business) => business.id === businessFilter);
  const selectedBusinessDbId = businessFilter === 'all'
    ? undefined
    : selectedBusiness?.dbId;
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
      setRefreshKey((key) => key + 1);
    } catch (error) {
      setReceiptStatus({ state: 'error', message: error instanceof Error ? error.message : 'Upload failed.' });
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

  return (
    <div
      style={{
        width: '100%',
        minHeight: '100vh',
        background: colors.bg,
        color: colors.ink,
        fontFamily: fonts.sans,
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
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
      />

      <TimeframeControls
        month={anchorMonth}
        preset={timePreset}
        label={timeWindow.display}
        onMonthChange={setAnchorMonth}
        onPresetChange={setTimePreset}
      />

      <div
        style={{
          flex: 1,
          display: 'grid',
          gridTemplateColumns: 'repeat(6, minmax(0, 1fr))',
          gridAutoRows: 'minmax(145px, auto)',
          gap: 10,
          minHeight: 0,
          alignItems: 'stretch',
        }}
      >
        <SpendHeroTile summary={summary} contextLabel={heroContext} detailLabel={heroDetail} />

        {businesses.map((b) => (
          <BusinessTile
            key={b.id}
            business={b}
            bg={`${b.color}33`}
            ink={b.color}
            transactions={transactions}
            caption={captionFor(b, transactions)}
          />
        ))}

        <AccountSpendTile
          accounts={accounts}
          businesses={businesses}
          transactions={transactions}
          selectedAccountIds={selectedAccountIds}
          onToggleAccount={toggleAccountFilter}
          onClearAccounts={() => setSelectedAccountIds([])}
          onManageAccounts={() => setConnectionsOpen(true)}
        />
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
          onOpenTransactions={() => setTransactionsOpen(true)}
        />
        <ReceiptDropTile onFile={handleUpload} status={receiptStatus} />
        <ActivityTile
          transactions={transactions}
          businesses={businesses}
          totalCount={transactions.length}
          onSelect={setSelectedTransaction}
          onViewAll={() => setTransactionsOpen(true)}
        />
        <ConnectionsTile connections={connections} onAdd={() => setConnectionsOpen(true)} />
        <AlertsTile alerts={alerts} />
      </div>
      <ConnectionsManager
        open={connectionsOpen}
        businesses={businesses}
        connections={connections}
        accounts={accounts}
        onClose={() => setConnectionsOpen(false)}
        onRefresh={() => setRefreshKey((key) => key + 1)}
      />
      <TransactionDrawer
        transaction={selectedTransaction}
        businesses={businesses}
        categories={categories}
        onClose={() => setSelectedTransaction(null)}
        onSaved={() => setRefreshKey((key) => key + 1)}
      />
      <TransactionExplorer
        open={transactionsOpen}
        businesses={businesses}
        accounts={accounts}
        categories={categories}
        initialBusiness={businessFilter}
        initialAccountIds={selectedAccountIds}
        initialQuery={query}
        onClose={() => setTransactionsOpen(false)}
        onSelect={(transaction) => {
          setSelectedTransaction(transaction);
        }}
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
    <div style={timeframeBarStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button type="button" onClick={() => shiftMonth(-1)} style={timeIconButtonStyle} title="Previous month">‹</button>
        <input
          type="month"
          value={month}
          onChange={(event) => onMonthChange(event.target.value)}
          style={monthInputStyle}
        />
        <button type="button" onClick={() => shiftMonth(1)} style={timeIconButtonStyle} title="Next month">›</button>
      </div>
      <div style={timePresetGroupStyle}>
        <PresetButton active={preset === 'month'} onClick={() => onPresetChange('month')}>Month</PresetButton>
        <PresetButton active={preset === 'last3'} onClick={() => onPresetChange('last3')}>Last 3m</PresetButton>
        <PresetButton active={preset === 'last12'} onClick={() => onPresetChange('last12')}>Last 12m</PresetButton>
        <PresetButton active={preset === 'ytd'} onClick={() => onPresetChange('ytd')}>YTD</PresetButton>
      </div>
      <span style={{ color: colors.dim, fontSize: 12 }}>{label}</span>
    </div>
  );
}

function PresetButton({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: 'none',
        borderRadius: radii.pill,
        background: active ? colors.ink : 'transparent',
        color: active ? colors.lemon : colors.dim,
        cursor: 'pointer',
        fontSize: 11,
        fontWeight: 900,
        padding: '5px 9px',
      }}
    >
      {children}
    </button>
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
    <div
      style={{
        minHeight: '100vh',
        background: colors.bg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: fonts.sans,
        color: tone === 'error' ? colors.coralInk : colors.dim,
        fontSize: 14,
      }}
    >
      {children}
    </div>
  );
}

const timeframeBarStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '0 8px',
  minHeight: 34,
};

const timePresetGroupStyle: React.CSSProperties = {
  display: 'flex',
  gap: 4,
  background: colors.paper,
  borderRadius: radii.pill,
  padding: 3,
};

const timeIconButtonStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  border: `1px solid ${colors.ink2}`,
  borderRadius: '50%',
  background: colors.paper,
  color: colors.ink,
  cursor: 'pointer',
  fontWeight: 900,
};

const monthInputStyle: React.CSSProperties = {
  border: `1px solid ${colors.ink2}`,
  borderRadius: radii.pill,
  background: colors.paper,
  color: colors.ink,
  padding: '5px 9px',
  fontSize: 12,
  fontWeight: 900,
  fontFamily: fonts.sans,
};
