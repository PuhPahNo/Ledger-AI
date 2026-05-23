import { useEffect, useState } from 'react';
import type { Business, CurrentUser, Transaction } from '@/types/domain';
import { colors, fonts } from '@/theme/tokens';
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
import { ConnectionsManager } from './ConnectionsManager';
import { TransactionDrawer } from './TransactionDrawer';

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
  const [comparisonBasis, setComparisonBasis] = useState<'month' | 'year'>('month');
  const [refreshKey, setRefreshKey] = useState(0);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null);
  const [receiptStatus, setReceiptStatus] = useState<{ state: 'idle' | 'uploading' | 'processing' | 'matched' | 'pending' | 'error'; message?: string }>({ state: 'idle' });
  const { data, loading, error } = useDashboard({ business: businessFilter, query, refreshKey, comparisonBasis, accountIds: selectedAccountIds });

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
  const selectedBusinessDbId = businessFilter === 'all'
    ? undefined
    : businesses.find((business) => business.id === businessFilter)?.dbId;

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

      <div
        style={{
          flex: 1,
          display: 'grid',
          gridTemplateColumns: 'repeat(6, minmax(0, 1fr))',
          gridTemplateRows: 'repeat(4, minmax(0, 1fr))',
          gap: 10,
          minHeight: 0,
        }}
      >
        <SpendHeroTile summary={summary} />

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
        <ReceiptDropTile onFile={handleUpload} status={receiptStatus} />
        <ActivityTile transactions={transactions} businesses={businesses} totalCount={transactions.length} onSelect={setSelectedTransaction} />
        <CategoriesTile
          categories={categories}
          comparisons={categoryComparisons}
          comparisonBasis={comparisonBasis}
          onComparisonBasisChange={setComparisonBasis}
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
    </div>
  );
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
