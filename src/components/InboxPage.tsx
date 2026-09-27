import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Copy, FileWarning, Inbox as InboxIcon, PlugZap, Receipt, Sparkles, TrendingUp, X } from 'lucide-react';
import {
  dismissAlert,
  listBusinesses,
  resolveCategorizationReviewItem,
  type AlertItem,
} from '@/api';
import type { AppView, TransactionViewFilters } from '@/types/navigation';
import type {
  Business,
  CategorizationReviewItem,
  CurrentUser,
} from '@/types/domain';
import { fmt$ } from '@/lib/format';
import { useToast } from '@/hooks/useToast';
import { inboxAttentionCount, useInbox } from '@/hooks/useInbox';
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
  const { data: inbox, loading, refresh: reloadInbox } = useInbox();
  const { receipts, reviewItems, troubledConnections, alerts } = inbox;
  const missingReceipts = inbox.missingReceipts;
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('all');
  const [resolving, setResolving] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    listBusinesses()
      .then((rows) => mounted && setBusinesses(rows))
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  const refresh = () => {
    void reloadInbox();
  };
  const businessByKey = useMemo(() => new Map(businesses.map((business) => [business.id, business])), [businesses]);

  const oldestReceipts = useMemo(() => (
    [...receipts].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, 6)
  ), [receipts]);
  const stuckReceipts = receipts.filter((receipt) => receiptNeedsDetails(receipt) || receipt.extractionError);
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

  const handleDismissAlert = async (alert: AlertItem) => {
    setResolving(alert.id);
    try {
      await dismissAlert(alert.id);
      refresh();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Could not dismiss',
        description: error instanceof Error ? error.message : 'Try again.',
      });
    } finally {
      setResolving(null);
    }
  };

  const attentionCount = inboxAttentionCount(inbox);
  const allClear = !loading && attentionCount === 0;

  return (
    <AppShell
      currentView="inbox"
      onViewChange={onViewChange}
      onLogout={onLogout}
      user={user}
      contextEyebrow="Workspace"
      contextTitle="Notifications"
    >
      <div className="flex flex-col gap-4">
        <div>
          <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">Workspace</div>
          <h1 className="font-display text-3xl font-bold tracking-tight">Needs attention</h1>
        </div>

        {alerts.length > 0 && (
          <section className="rounded-xl border border-ink2/10 bg-paper shadow-sm">
            <div className="flex items-center gap-2 border-b border-ink2/10 px-4 py-3">
              <TrendingUp className="h-4 w-4 text-dim" />
              <h2 className="font-display text-lg font-bold">Spend alerts</h2>
              <Badge variant="warning">{alerts.length}</Badge>
            </div>
            <div className="divide-y divide-ink2/10">
              {alerts.map((alert) => (
                <div key={alert.id} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                  {alert.kind === 'dup'
                    ? <Copy className="mt-0.5 h-4 w-4 shrink-0 text-coral-ink" />
                    : <TrendingUp className="mt-0.5 h-4 w-4 shrink-0 text-dim" />}
                  <div className="min-w-0 flex-1">
                    <div className="font-bold">{alert.title}</div>
                    <div className="text-xs text-dim">{alert.detail}</div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={resolving === alert.id}
                    onClick={() => void handleDismissAlert(alert)}
                    title="Dismiss — it won't come back"
                  >
                    <X className="h-3.5 w-3.5" />
                    Dismiss
                  </Button>
                </div>
              ))}
            </div>
          </section>
        )}

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

        {missingReceipts.rows > 0 && (
          <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink2/10 bg-paper px-4 py-3 shadow-sm">
            <div className="text-sm">
              <span className="font-bold">{missingReceipts.rows} transaction{missingReceipts.rows === 1 ? '' : 's'}</span>
              <span className="text-dim"> still missing a receipt ({fmt$(Math.abs(missingReceipts.outflowCents) / 100)} of spend)</span>
            </div>
            <Button variant="outline" size="sm" onClick={() => onOpenTransactions?.({ receipts: ['missing'], direction: 'operating-outflow' })}>
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

        {loading && <div className="p-6 text-center text-sm text-dim">Loading notifications…</div>}
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
