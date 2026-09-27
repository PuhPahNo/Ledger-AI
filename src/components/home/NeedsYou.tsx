import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  FileWarning,
  PlugZap,
  Receipt,
  Sparkles,
  TrendingUp,
  X,
} from 'lucide-react';
import { dismissAlert, resolveCategorizationReviewItem, type AlertItem } from '@/api';
import type { Business, CategorizationReviewItem } from '@/types/domain';
import type { NavigateFn, TransactionViewFilters } from '@/types/navigation';
import { inboxAttentionCount, type InboxData } from '@/hooks/useInbox';
import { useToast } from '@/hooks/useToast';
import { fmt$ } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ReviewItemCard } from '../review/ReviewItemCard';
import { receiptNeedsDetails } from '../receipts/ReceiptWorkbenchParts';
import { NEEDS_YOU_ANCHOR } from '../AppShell';

interface Props {
  inbox: InboxData;
  loading: boolean;
  businesses: Business[];
  onRefresh: () => void;
  onViewChange?: NavigateFn;
  onOpenTransactions?: (filters?: TransactionViewFilters) => void;
}

/**
 * Home's "Needs you" — everything waiting on the owner, one compact row per kind, each
 * linking to where it gets fixed. Rows render in priority order.
 *
 * To add a kind (phase 2: receipt queue states, grouped reviews, QuickBooks sync errors):
 *   1. load it in hooks/useInbox.ts (InboxData + fetchInbox) and count it in
 *      inboxAttentionCount so the nav badge and bell agree;
 *   2. add a row component below and render it in the list.
 */
export function NeedsYou({ inbox, loading, businesses, onRefresh, onViewChange, onOpenTransactions }: Props) {
  const count = inboxAttentionCount(inbox);
  return (
    <section id={NEEDS_YOU_ANCHOR} aria-labelledby="needs-you-title" className="scroll-mt-4 rounded-xl border border-ink2/10 bg-paper shadow-sm">
      <div className="flex items-center gap-2 border-b border-ink2/10 px-4 py-2.5">
        <h2 id="needs-you-title" className="font-display text-base font-bold">Needs you</h2>
        {count > 0 && <Badge variant="warning">{count}</Badge>}
      </div>
      {count === 0 ? (
        <div className="flex items-center gap-2 px-4 py-3 text-sm text-dim">
          <CheckCircle2 className="h-4 w-4 text-sage-ink" />
          {loading ? 'Checking…' : 'All caught up — no receipts to pair, reviews, or sync problems.'}
        </div>
      ) : (
        <ul className="divide-y divide-ink2/10">
          <ConnectionsRow inbox={inbox} onViewChange={onViewChange} />
          <ReceiptsRow inbox={inbox} onViewChange={onViewChange} />
          <ReviewsRow inbox={inbox} businesses={businesses} onRefresh={onRefresh} />
          <MissingReceiptsRow inbox={inbox} onOpenTransactions={onOpenTransactions} />
          <AlertRows inbox={inbox} onRefresh={onRefresh} onViewChange={onViewChange} onOpenTransactions={onOpenTransactions} />
        </ul>
      )}
    </section>
  );
}

type Tone = 'danger' | 'warning' | 'info';

/** One compact line: icon, what's waiting, and the button that takes you to fix it. */
function NeedsYouRow({
  icon,
  tone,
  title,
  detail,
  action,
  children,
}: {
  icon: ReactNode;
  tone: Tone;
  title: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
            tone === 'danger' && 'bg-coral/20 text-coral-ink',
            tone === 'warning' && 'bg-lemon/40 text-lemon-ink dark:bg-lemon/15 dark:text-lemon',
            tone === 'info' && 'bg-[hsl(var(--color-sunken))] text-dim',
          )}
          aria-hidden="true"
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1 basis-48">
          <div className="text-sm font-bold text-ink">{title}</div>
          {detail && <div className="truncate text-xs text-dim">{detail}</div>}
        </div>
        {action && <div className="ml-auto flex shrink-0 flex-wrap items-center gap-1.5">{action}</div>}
      </div>
      {children}
    </li>
  );
}

function GoButton({ label, onClick }: { label: string; onClick?: () => void }) {
  return (
    <Button variant="outline" size="sm" onClick={onClick}>
      {label}
      <ArrowRight className="h-3.5 w-3.5" />
    </Button>
  );
}

function ConnectionsRow({ inbox, onViewChange }: { inbox: InboxData; onViewChange?: NavigateFn }) {
  const rows = inbox.troubledConnections;
  if (!rows.length) return null;
  return (
    <NeedsYouRow
      icon={<PlugZap className="h-4 w-4" />}
      tone="danger"
      title={`${rows.length} connection${rows.length === 1 ? ' needs' : 's need'} attention`}
      detail={rows.map((connection) => (
        `${connection.label} (${connection.status !== 'live'
          ? connection.status
          : connection.health?.lastJobError ?? `${connection.health?.failedJobCount ?? 0} failed sync${connection.health?.failedJobCount === 1 ? '' : 's'}`})`
      )).join(' · ')}
      action={<GoButton label="Fix" onClick={() => onViewChange?.({ view: 'settings', section: 'businesses' })} />}
    />
  );
}

function ReceiptsRow({ inbox, onViewChange }: { inbox: InboxData; onViewChange?: NavigateFn }) {
  const receipts = inbox.receipts;
  if (!receipts.length) return null;
  const stuck = receipts.filter((receipt) => receiptNeedsDetails(receipt) || receipt.extractionError).length;
  const oldest = receipts.reduce((min, receipt) => (receipt.createdAt < min ? receipt.createdAt : min), receipts[0].createdAt);
  const oldestDays = Math.floor((Date.now() - Date.parse(oldest)) / 86_400_000);
  return (
    <NeedsYouRow
      icon={<Receipt className="h-4 w-4" />}
      tone={oldestDays >= 14 ? 'danger' : 'warning'}
      title={`${receipts.length}${receipts.length >= 100 ? '+' : ''} receipt${receipts.length === 1 ? '' : 's'} to pair`}
      detail={[
        Number.isFinite(oldestDays) && oldestDays >= 1 ? `oldest ${oldestDays} day${oldestDays === 1 ? '' : 's'}` : 'newest today',
        stuck ? `${stuck} need${stuck === 1 ? 's' : ''} details` : null,
      ].filter(Boolean).join(' · ')}
      action={<GoButton label="Pair" onClick={() => onViewChange?.({ view: 'transactions', mode: 'receipts' })} />}
    />
  );
}

function ReviewsRow({ inbox, businesses, onRefresh }: { inbox: InboxData; businesses: Business[]; onRefresh: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);
  const items = inbox.reviewItems;
  const businessByKey = useMemo(() => new Map(businesses.map((business) => [business.id, business])), [businesses]);
  if (!items.length) return null;
  const aiSuggestions = items.filter((item) => item.type === 'ai_category_suggestion');

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
      onRefresh();
    } catch (error) {
      toast({ variant: 'destructive', title: 'Review update failed', description: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setResolving(null);
    }
  };
  const acceptAllAi = async () => {
    // Sequential on purpose: each accept can create rules/conflicts the next one sees.
    for (const item of aiSuggestions) {
      // eslint-disable-next-line no-await-in-loop
      await resolve(item, 'accept');
    }
  };

  return (
    <NeedsYouRow
      icon={<Sparkles className="h-4 w-4" />}
      tone="warning"
      title={`${items.length} categor${items.length === 1 ? 'y review' : 'y reviews'}`}
      detail={items.slice(0, 3).map((item) => item.payload.merchant ?? item.title).join(' · ')}
      action={(
        <>
          {aiSuggestions.length > 1 && (
            <Button variant="secondary" size="sm" onClick={acceptAllAi} disabled={Boolean(resolving)}>
              Accept {aiSuggestions.length} AI
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
            {open ? 'Hide' : 'Review'}
            {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </Button>
        </>
      )}
    >
      {open && (
        <div className="mt-3 grid gap-2">
          {items.map((item) => (
            <ReviewItemCard
              key={item.id}
              item={item}
              business={businessByKey.get(item.biz)}
              disabled={resolving === item.id}
              onResolve={resolve}
            />
          ))}
        </div>
      )}
    </NeedsYouRow>
  );
}

function MissingReceiptsRow({ inbox, onOpenTransactions }: { inbox: InboxData; onOpenTransactions?: (filters?: TransactionViewFilters) => void }) {
  const missing = inbox.missingReceipts;
  if (missing.rows <= 0) return null;
  return (
    <NeedsYouRow
      icon={<FileWarning className="h-4 w-4" />}
      tone="info"
      title={`${missing.rows} transaction${missing.rows === 1 ? '' : 's'} missing a receipt`}
      detail={`${fmt$(Math.abs(missing.outflowCents) / 100)} of spend`}
      action={<GoButton label="Review" onClick={() => onOpenTransactions?.({ receipts: ['missing'], direction: 'operating-outflow' })} />}
    />
  );
}

function AlertRows({
  inbox,
  onRefresh,
  onViewChange,
  onOpenTransactions,
}: {
  inbox: InboxData;
  onRefresh: () => void;
  onViewChange?: NavigateFn;
  onOpenTransactions?: (filters?: TransactionViewFilters) => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const dismiss = async (alert: AlertItem) => {
    setBusy(alert.id);
    try {
      await dismissAlert(alert.id);
      onRefresh();
    } catch (error) {
      toast({ variant: 'destructive', title: 'Could not dismiss', description: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setBusy(null);
    }
  };
  // Where each alert kind gets looked into.
  const openFor = (alert: AlertItem): (() => void) | undefined => {
    const business = alert.biz ?? undefined;
    switch (alert.kind) {
      case 'missing':
        return () => onOpenTransactions?.({ business, receipts: ['missing'], direction: 'operating-outflow' });
      case 'orphan':
        return () => onViewChange?.({ view: 'transactions', mode: 'receipts' });
      case 'dup':
      case 'spike':
        return () => onOpenTransactions?.({ business, direction: 'operating-outflow' });
      default:
        return undefined;
    }
  };
  return (
    <>
      {inbox.alerts.map((alert) => {
        const open = openFor(alert);
        return (
          <NeedsYouRow
            key={alert.id}
            icon={alert.kind === 'dup' ? <Copy className="h-4 w-4" /> : <TrendingUp className="h-4 w-4" />}
            tone={alert.kind === 'dup' ? 'danger' : 'info'}
            title={alert.title}
            detail={alert.detail}
            action={(
              <>
                {open && <GoButton label="View" onClick={open} />}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={busy === alert.id}
                  onClick={() => void dismiss(alert)}
                  title="Dismiss — it won't come back"
                  aria-label={`Dismiss alert: ${alert.title}`}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </>
            )}
          />
        );
      })}
    </>
  );
}
