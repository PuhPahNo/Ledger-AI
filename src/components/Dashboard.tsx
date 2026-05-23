import type { Business, Transaction } from '@/types/domain';
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

/** Display-only caption for a business tile, computed from the loaded transactions. */
function captionFor(biz: Business, txns: Transaction[]): string {
  const total = txns.filter((t) => t.biz === biz.id).length;
  const missing = countNeedsReceipt(txns, biz.id);
  const dup = countDuplicateSubs(txns, biz.id);
  if (dup > 0) return `${total} txns · ${dup} dup sub`;
  if (missing > 0) return `${total} txns · ${missing} needs receipt`;
  return `${total} txns`;
}

/** Tile background per business. Pure presentation — palette lives in tokens. */
const businessPalette: Record<string, { bg: string; ink: string }> = {
  aurora:   { bg: colors.coral, ink: colors.coralInk },
  meridian: { bg: colors.sky,   ink: colors.skyInk },
  kiln:     { bg: colors.sage,  ink: colors.sageInk },
};

interface DashboardProps {
  onViewChange?: (view: 'dashboard' | 'admin') => void;
  onLogout?: () => void;
}

export function Dashboard({ onViewChange, onLogout }: DashboardProps) {
  const { data, loading, error } = useDashboard();

  if (error) return <StateScreen tone="error">Couldn't load: {error.message}</StateScreen>;
  if (loading || !data) return <StateScreen>Loading…</StateScreen>;

  const { businesses, transactions, categories, connections, alerts, summary } = data;

  const handleUpload = (file: File) => {
    uploadReceipt(file).catch((e: Error) => {
      // Mock backend rejects; in real backend this fires the OCR + match flow.
      // Leaving this as a console signal until the toast system lands.
      console.warn('Receipt upload not yet available:', e.message);
    });
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
      <HeaderBar onUploadReceipt={handleUpload} currentView="dashboard" onViewChange={onViewChange} onLogout={onLogout} />

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
            bg={businessPalette[b.id]?.bg ?? colors.paper}
            ink={businessPalette[b.id]?.ink ?? colors.ink}
            transactions={transactions}
            caption={captionFor(b, transactions)}
          />
        ))}

        <ReceiptDropTile onFile={handleUpload} />
        <ActivityTile transactions={transactions} businesses={businesses} totalCount={482} />
        <CategoriesTile categories={categories} />
        <ConnectionsTile connections={connections} />
        <AlertsTile alerts={alerts} />
      </div>
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
