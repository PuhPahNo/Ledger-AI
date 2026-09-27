import { useMemo, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  Copy,
  FileWarning,
  PlugZap,
  Receipt,
  TrendingUp,
  X,
} from 'lucide-react';
import { dismissAlert, type AlertItem } from '@/api';
import type { Business } from '@/types/domain';
import type { NavigateFn, TransactionViewFilters } from '@/types/navigation';
import { inboxAttentionCount, type InboxData } from '@/hooks/useInbox';
import { useToast } from '@/hooks/useToast';
import { fmt$ } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ReviewGroupRow } from '../review/ReviewGroupRow';
import { AutomationLine } from './AutomationLine';
import { GoButton, NeedsYouRow } from './NeedsYouRow';
import { receiptNeedsDetails } from '../receipts/ReceiptWorkbenchParts';
import { NEEDS_YOU_ANCHOR } from '../AppShell';

/** Review groups shown before "N more"; the rest stay one click away (still counted). */
const VISIBLE_REVIEW_GROUPS = 5;

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
 * To add a kind (receipt queue states, QuickBooks sync errors):
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
          <ReviewGroupRows inbox={inbox} businesses={businesses} onRefresh={onRefresh} />
          <MissingReceiptsRow inbox={inbox} onOpenTransactions={onOpenTransactions} />
          <AlertRows inbox={inbox} onRefresh={onRefresh} onViewChange={onViewChange} onOpenTransactions={onOpenTransactions} />
        </ul>
      )}
      <AutomationLine onChanged={onRefresh} />
    </section>
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

/** Grouped category reviews: one row per decision, the first few shown, the rest one click away. */
function ReviewGroupRows({ inbox, businesses, onRefresh }: { inbox: InboxData; businesses: Business[]; onRefresh: () => void }) {
  const [showAll, setShowAll] = useState(false);
  const businessByKey = useMemo(() => new Map(businesses.map((business) => [business.id, business])), [businesses]);
  const groups = inbox.reviewGroups;
  if (!groups.length) return null;
  const visible = showAll ? groups : groups.slice(0, VISIBLE_REVIEW_GROUPS);
  const hidden = groups.length - visible.length;
  return (
    <>
      {visible.map((group) => (
        <ReviewGroupRow
          key={group.groupKey}
          group={group}
          items={inbox.reviewItems}
          business={businesses.length > 1 && group.biz ? businessByKey.get(group.biz) : undefined}
          onResolved={onRefresh}
        />
      ))}
      {hidden > 0 && (
        <li className="px-4 py-1.5">
          <Button variant="ghost" size="sm" className="text-dim" onClick={() => setShowAll(true)}>
            {hidden} more categor{hidden === 1 ? 'y review' : 'y reviews'}
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </li>
      )}
    </>
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
