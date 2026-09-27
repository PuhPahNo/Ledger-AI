import { useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import type { CurrentUser, Transaction } from '@/types/domain';
import type { NavigateFn, TransactionViewFilters } from '@/types/navigation';
import { listCategories, uploadReceipt } from '@/api';
import { clearHomeCache, useHome } from '@/hooks/useHome';
import { useInbox } from '@/hooks/useInbox';
import { useToast } from '@/hooks/useToast';
import { currentMonthKey, formatMonthLabel, shiftMonthKey } from '@/lib/dates';
import { daysInRange, type TimePreset } from '@/lib/periods';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { AppShell } from '../AppShell';
import { TransactionDrawer } from '../TransactionDrawer';
import { CategoryBars } from './CategoryBars';
import { KpiRow } from './KpiRow';
import { NeedsYou } from './NeedsYou';
import { RecentActivity } from './RecentActivity';
import { SpendPaceChart } from './SpendPaceChart';
import { TimeframeControls } from './TimeframeControls';

interface Props {
  user?: CurrentUser;
  onViewChange?: NavigateFn;
  onOpenTransactions?: (filters?: TransactionViewFilters) => void;
  onLogout?: () => void;
}

/**
 * Home: what needs doing, then how this period is going. Deliberately short — breakdowns by
 * business, top purchases and balances live in Reports; account filtering in Transactions.
 */
export function HomePage({ user, onViewChange, onOpenTransactions, onLogout }: Props) {
  const { toast } = useToast();
  const [business, setBusiness] = useState('all');
  const [month, setMonth] = useState(() => currentMonthKey());
  const [preset, setPreset] = useState<TimePreset>('month');
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null);
  const [drawerCategories, setDrawerCategories] = useState<Awaited<ReturnType<typeof listCategories>>>([]);
  const { data, loading, error } = useHome({ business, month, preset, refreshKey });
  const { data: inbox, loading: inboxLoading, refresh: refreshInbox } = useInbox();

  const refresh = () => {
    clearHomeCache();
    setRefreshKey((key) => key + 1);
    void refreshInbox();
  };

  const businesses = data?.businesses ?? [];
  const handleUpload = async (file: File) => {
    try {
      const businessDbId = business === 'all' ? undefined : businesses.find((item) => item.id === business)?.dbId;
      const result = await uploadReceipt(file, businessDbId);
      toast({
        variant: result.matched ? 'success' : 'default',
        title: result.matched ? 'Receipt matched' : 'Receipt queued',
        description: result.matched ? `Matched ${result.matched.merchant}.` : 'Reading and matching it now.',
      });
      refresh();
    } catch (uploadError) {
      toast({ variant: 'destructive', title: 'Upload failed', description: uploadError instanceof Error ? uploadError.message : 'Try again.' });
    }
  };

  const openTransaction = (transaction: Transaction) => {
    setSelectedTransaction(transaction);
    if (!drawerCategories.length) listCategories().then(setDrawerCategories).catch(() => undefined);
  };

  const labels = periodLabels(month, preset, data?.window.display ?? '');
  const scope = { business: business === 'all' ? undefined : business };
  const windowTo = data?.asOf ?? data?.window.to;

  return (
    <AppShell
      currentView="home"
      onViewChange={onViewChange}
      onLogout={onLogout}
      user={user}
      onUploadReceipt={handleUpload}
      contextEyebrow="Workspace"
      contextTitle="Home"
      businesses={businesses}
      selectedBusiness={business}
      onBusinessChange={setBusiness}
    >
      <div className="flex flex-col gap-4">
        <NeedsYou
          inbox={inbox}
          loading={inboxLoading}
          businesses={businesses}
          onRefresh={refresh}
          onViewChange={onViewChange}
          onOpenTransactions={onOpenTransactions}
        />

        <TimeframeControls
          month={month}
          preset={preset}
          label={data?.window.display ?? ''}
          onMonthChange={setMonth}
          onPresetChange={setPreset}
        />

        {error && !data && (
          <div role="alert" className="rounded-xl border border-coral/30 bg-coral/10 p-4 text-sm font-bold text-coral-ink">
            Couldn't load this period: {error.message}
          </div>
        )}

        {!data ? (
          <HomeSkeleton />
        ) : (
          <div className={loading ? 'flex flex-col gap-4 opacity-60 transition-opacity' : 'flex flex-col gap-4 transition-opacity'} aria-busy={loading}>
            <KpiRow
              spend={data.pace.spend}
              income={data.pace.income}
              net={data.pace.net}
              compareLabel={labels.compare}
              accounts={data.accounts}
              onOpenSpend={() => onOpenTransactions?.({ ...scope, from: data.window.from, to: windowTo, direction: 'operating-outflow' })}
              onOpenIncome={() => onOpenTransactions?.({ ...scope, from: data.window.from, to: windowTo, direction: 'inflow' })}
              onOpenNet={() => onViewChange?.({ view: 'reports', tab: 'overview' })}
              onOpenAccounts={() => onViewChange?.({ view: 'reports', tab: 'accounts' })}
            />

            <div className="grid gap-3 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] xl:items-start">
              <HomeCard eyebrow="Spend pace" title={labels.chartTitle}>
                <SpendPaceChart
                  pace={data.pace}
                  windowFrom={data.window.from}
                  windowDays={daysInRange(data.window.from, data.window.to)}
                  currentLabel={labels.current}
                  previousLabel={labels.previous}
                />
              </HomeCard>
              <HomeCard eyebrow="Categories" title="Where it went">
                <CategoryBars
                  rows={data.categories}
                  compareLabel={labels.compare}
                  onSelect={(category) => onOpenTransactions?.({
                    ...scope,
                    categories: [category],
                    from: data.window.from,
                    to: windowTo,
                    direction: 'operating-outflow',
                  })}
                />
              </HomeCard>
            </div>

            <HomeCard
              eyebrow="Activity"
              title="Recent"
              action={(
                <Button variant="outline" size="sm" onClick={() => onOpenTransactions?.({ ...scope, from: data.window.from, to: windowTo })}>
                  View all
                  <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              )}
            >
              <RecentActivity transactions={data.recent} businesses={businesses} onSelect={openTransaction} />
            </HomeCard>
          </div>
        )}
      </div>

      <TransactionDrawer
        transaction={selectedTransaction}
        businesses={businesses}
        categories={drawerCategories}
        onClose={() => setSelectedTransaction(null)}
        onSaved={refresh}
      />
    </AppShell>
  );
}

function HomeCard({ eyebrow, title, action, children }: { eyebrow: string; title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Card className="flex min-w-0 flex-col gap-3 p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">{eyebrow}</div>
          <h2 className="font-display text-lg font-bold text-ink">{title}</h2>
        </div>
        {action}
      </div>
      {children}
    </Card>
  );
}

function HomeSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden="true">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((index) => <Skeleton key={index} className="h-[92px]" />)}
      </div>
      <div className="grid gap-3 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <Skeleton className="h-72" />
        <Skeleton className="h-72" />
      </div>
    </div>
  );
}

/** Words for the comparison: "same day last month" for months, "same point last period" otherwise. */
function periodLabels(month: string, preset: TimePreset, display: string) {
  if (preset === 'month') {
    const isCurrent = month === currentMonthKey();
    const previousMonth = formatMonthLabel(shiftMonthKey(month, -1), 'long').split(' ')[0];
    const thisMonth = formatMonthLabel(month, 'long').split(' ')[0];
    return {
      current: isCurrent ? 'This month' : thisMonth,
      previous: isCurrent ? 'Last month' : previousMonth,
      compare: isCurrent ? 'same day last month' : previousMonth,
      chartTitle: isCurrent ? 'Month to date vs last month' : `${thisMonth} vs ${previousMonth}`,
    };
  }
  return {
    current: 'This period',
    previous: 'Prior period',
    compare: 'same point last period',
    chartTitle: `${display || 'This period'} vs the one before`,
  };
}
