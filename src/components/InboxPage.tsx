import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, FileWarning, Inbox as InboxIcon, PlugZap, Receipt, Sparkles } from 'lucide-react';
import {
  getTransactionRollup,
  listBusinesses,
  listCategorizationReviewItems,
  listConnections,
  listReceipts,
  resolveCategorizationReviewItem,
} from '@/api';
import type { AppView, TransactionViewFilters } from '@/types/navigation';
import type {
  Business,
  CategorizationReviewItem,
  Connection,
  CurrentUser,
  ReceiptInboxItem,
} from '@/types/domain';
import { fmt$ } from '@/lib/format';
import { useToast } from '@/hooks/useToast';
import { AppShell } from './AppShell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ReviewItemCard, reviewTypeLabel } from './review/ReviewItemCard';
import { receiptLabel, receiptNeedsDetails } from './receipts/ReceiptWorkbenchParts';

interface Props {
  user?: CurrentUser;
  onViewChange?: (view: AppView) => void;
  onOpenTransactions?: (filters?: TransactionViewFilters) => void;
  onLogout?: () => void;
}

type ReviewFilter = 'all' | CategorizationReviewItem['type'];

/**
 * Everything waiting on the owner, in one place: receipts to pair (oldest first),
 * categorization reviews, transactions missing receipts, and unhealthy connections.
 * Previously scattered across four surfaces.
 */
export function InboxPage({ user, onViewChange, onOpenTransactions, onLogout }: Props) {
  const { toast } = useToast();
  const [receipts, setReceipts] = useState<ReceiptInboxItem[]>([]);
  const [reviewItems, setReviewItems] = useState<CategorizationReviewItem[]>([]);
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [missingReceipts, setMissingReceipts] = useState<{ rows: number; outflowCents: number } | null>(null);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('all');
  const [resolving, setResolving] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    Promise.allSettled([
      listReceipts({ status: 'pending', unmatched: true, limit: 100 }),
      listCategorizationReviewItems(),
      listBusinesses(),
      listConnections(),
      getTransactionRollup({ receipts: ['missing'] }),
    ]).then(([receiptsResult, reviewResult, businessesResult, connectionsResult, rollupResult]) => {
      if (!mounted) return;
      if (receiptsResult.status === 'fulfilled') setReceipts(receiptsResult.value);
      if (reviewResult.status === 'fulfilled') setReviewItems(reviewResult.value);
      if (businessesResult.status === 'fulfilled') setBusinesses(businessesResult.value);
      if (connectionsResult.status === 'fulfilled') setConnections(connectionsResult.value);
      if (rollupResult.status === 'fulfilled') {
        setMissingReceipts({ rows: rollupResult.value.rows, outflowCents: rollupResult.value.outflowCents });
      }
      setLoading(false);
    });
    return () => {
      mounted = false;
    };
  }, [refreshKey]);

  const refresh = () => setRefreshKey((key) => key + 1);
  const businessByKey = useMemo(() => new Map(businesses.map((business) => [business.id, business])), [businesses]);

  const oldestReceipts = useMemo(() => (
    [...receipts].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, 6)
  ), [receipts]);
  const stuckReceipts = receipts.filter((receipt) => receiptNeedsDetails(receipt) || receipt.extractionError);
  const troubledConnections = connections.filter((connection) => (
    connection.status !== 'live'
    || (connection.health?.failedJobCount ?? 0) > 0
    || Boolean(connection.health?.lastJobError)
  ));
  const filteredReviewItems = reviewFilter === 'all'
    ? reviewItems
    : reviewItems.filter((item) => item.type === reviewFilter);
  const aiSuggestions = reviewItems.filter((item) => item.type === 'ai_category_suggestion');
  const reviewTypes = [...new Set(reviewItems.map((item) => item.type))];

  const resolve = async (item: CategorizationReviewItem, action: 'accept' | 'dismiss') => {
    setResolving(item.id);
    try {
      const result = await resolveCategorizationReviewItem(item.id, action);
      toast({
        variant: action === 'accept' ? 'success' : 'default',
        title: action === 'accept' ? 'Applied' : 'Dismissed',
        description: result.appliedCount > 0
          ? `${result.appliedCount} transaction${result.appliedCount === 1 ? '' : 's'} updated.`
          : undefined,
      });
      refresh();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Review update failed',
        description: error instanceof Error ? error.message : 'Try again.',
      });
    } finally {
      setResolving(null);
    }
  };

  const acceptAiSuggestions = async () => {
    for (const item of aiSuggestions) {
      // Sequential on purpose: each accept can create rules/conflicts the next one sees.
      // eslint-disable-next-line no-await-in-loop
      await resolve(item, 'accept');
    }
  };

  const dismissVisible = async () => {
    for (const item of filteredReviewItems) {
      // eslint-disable-next-line no-await-in-loop
      await resolve(item, 'dismiss');
    }
  };

  const allClear = !loading
    && receipts.length === 0
    && reviewItems.length === 0
    && (missingReceipts?.rows ?? 0) === 0
    && troubledConnections.length === 0;

  return (
    <AppShell
      currentView="inbox"
      onViewChange={onViewChange}
      onLogout={onLogout}
      user={user}
      contextEyebrow="Workspace"
      contextTitle="Inbox"
    >
      <div className="flex flex-col gap-4">
        <div>
          <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">Workspace</div>
          <h1 className="font-display text-3xl font-bold tracking-tight">Needs attention</h1>
        </div>

        {allClear && (
          <EmptyState
            title="You're all caught up"
            description="No receipts to pair, no reviews waiting, nothing missing."
            icon={<InboxIcon className="h-5 w-5" />}
          />
        )}

        {(troubledConnections.length > 0) && (
          <section className="rounded-xl border border-coral/30 bg-coral/10 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 font-bold text-coral-ink">
                <PlugZap className="h-4 w-4" />
                {troubledConnections.length} connection{troubledConnections.length === 1 ? ' needs' : 's need'} attention
              </div>
              <Button variant="outline" size="sm" onClick={() => onViewChange?.('balances')}>
                Connection health
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="mt-2 grid gap-1 text-xs text-coral-ink/90">
              {troubledConnections.map((connection) => (
                <div key={connection.id ?? connection.label} className="truncate">
                  <span className="font-bold">{connection.label}</span>
                  {' · '}
                  {connection.status !== 'live'
                    ? `status: ${connection.status}`
                    : connection.health?.lastJobError ?? `${connection.health?.failedJobCount} failed job(s)`}
                </div>
              ))}
            </div>
          </section>
        )}

        {receipts.length > 0 && (
          <section className="rounded-xl border border-ink2/10 bg-paper shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink2/10 px-4 py-3">
              <div className="flex items-center gap-2">
                <Receipt className="h-4 w-4 text-dim" />
                <h2 className="font-display text-lg font-bold">Receipts to pair</h2>
                <Badge variant="warning">{receipts.length}</Badge>
                {stuckReceipts.length > 0 && (
                  <Badge variant="danger">{stuckReceipts.length} stuck</Badge>
                )}
              </div>
              <Button size="sm" onClick={() => onViewChange?.('receipts')}>
                Open workbench
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="divide-y divide-ink2/10">
              {oldestReceipts.map((receipt) => (
                <button
                  key={receipt.id}
                  type="button"
                  onClick={() => onViewChange?.('receipts')}
                  className="flex w-full flex-wrap items-center gap-2 px-4 py-2.5 text-left text-sm hover:bg-cream/70"
                >
                  <span className="min-w-0 flex-1 truncate font-bold">{receiptLabel(receipt)}</span>
                  {(receiptNeedsDetails(receipt) || receipt.extractionError) && (
                    <Badge variant="danger">
                      <FileWarning className="mr-1 h-3 w-3" />
                      needs details
                    </Badge>
                  )}
                  {receipt.totalCents != null && (
                    <span className="tabular-nums text-dim">{fmt$(receipt.totalCents / 100)}</span>
                  )}
                  <AgeBadge createdAt={receipt.createdAt} />
                </button>
              ))}
            </div>
            {receipts.length > oldestReceipts.length && (
              <div className="border-t border-ink2/10 px-4 py-2 text-xs text-dim">
                +{receipts.length - oldestReceipts.length} more in the workbench
              </div>
            )}
          </section>
        )}

        {(missingReceipts?.rows ?? 0) > 0 && (
          <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink2/10 bg-paper px-4 py-3 shadow-sm">
            <div className="text-sm">
              <span className="font-bold">{missingReceipts!.rows} transaction{missingReceipts!.rows === 1 ? '' : 's'}</span>
              <span className="text-dim"> still missing a receipt ({fmt$(Math.abs(missingReceipts!.outflowCents) / 100)} of spend)</span>
            </div>
            <Button variant="outline" size="sm" onClick={() => onOpenTransactions?.({ receipts: ['missing'] })}>
              Review in Transactions
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </section>
        )}

        {reviewItems.length > 0 && (
          <section className="rounded-xl border border-ink2/10 bg-paper shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink2/10 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Sparkles className="h-4 w-4 text-dim" />
                <h2 className="font-display text-lg font-bold">Category reviews</h2>
                <Badge variant="warning">{reviewItems.length}</Badge>
                {reviewTypes.length > 1 && (
                  <div className="ml-2 flex flex-wrap gap-1">
                    <FilterChip active={reviewFilter === 'all'} onClick={() => setReviewFilter('all')}>All</FilterChip>
                    {reviewTypes.map((type) => (
                      <FilterChip key={type} active={reviewFilter === type} onClick={() => setReviewFilter(type)}>
                        {reviewTypeLabel(type)}
                      </FilterChip>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                {aiSuggestions.length > 1 && (
                  <Button size="sm" variant="secondary" onClick={acceptAiSuggestions} disabled={Boolean(resolving)}>
                    <Sparkles className="h-3.5 w-3.5" />
                    Accept all AI ({aiSuggestions.length})
                  </Button>
                )}
                {filteredReviewItems.length > 1 && (
                  <Button size="sm" variant="ghost" onClick={dismissVisible} disabled={Boolean(resolving)}>
                    Dismiss all shown
                  </Button>
                )}
              </div>
            </div>
            <div className="grid gap-3 p-4">
              {filteredReviewItems.map((item) => (
                <ReviewItemCard
                  key={item.id}
                  item={item}
                  business={businessByKey.get(item.biz)}
                  disabled={resolving === item.id}
                  onResolve={resolve}
                />
              ))}
            </div>
          </section>
        )}

        {loading && <div className="p-6 text-center text-sm text-dim">Loading inbox…</div>}
      </div>
    </AppShell>
  );
}

function AgeBadge({ createdAt }: { createdAt: string }) {
  const days = Math.floor((Date.now() - Date.parse(createdAt)) / 86_400_000);
  if (!Number.isFinite(days) || days < 1) return <span className="text-xs text-dim">today</span>;
  const label = days === 1 ? '1 day' : `${days} days`;
  return (
    <span className={days >= 14 ? 'text-xs font-bold text-coral-ink' : 'text-xs text-dim'}>
      {label}
    </span>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={active
        ? 'rounded-full bg-inverse px-2.5 py-1 text-[11px] font-bold text-inverse-foreground'
        : 'rounded-full bg-cream px-2.5 py-1 text-[11px] font-bold text-dim hover:text-ink'}
    >
      {children}
    </button>
  );
}
