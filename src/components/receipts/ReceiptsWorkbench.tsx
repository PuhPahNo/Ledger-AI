import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { getReceipt, listBusinesses, receiptExtractionSettled, uploadReceipt } from '@/api';
import { listRecentMatches } from '@/api/receiptWorkflow';
import type { NavigateFn } from '@/types/navigation';
import type { Business, CurrentUser } from '@/types/domain';
import type { RecentMatch } from '@/types/receiptWorkflow';
import { useToast } from '@/hooks/useToast';
import { cn } from '@/lib/cn';
import { AppShell } from '../AppShell';
import { MatchQueue } from './MatchQueue';
import { RecentMatches } from './RecentMatches';
import { receiptLabel } from './ReceiptWorkbenchParts';

const EXTRACTION_POLL_TIMEOUT_MS = 90_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type ReceiptsView = 'queue' | 'matched';

interface Props {
  user?: CurrentUser;
  onViewChange?: NavigateFn;
  onLogout?: () => void;
  /** The Transactions | Receipts segmented control, rendered above the workbench. */
  modeSwitch?: ReactNode;
  /** Unmatched receipts from GET /receipts/counts (null until loaded). */
  unmatched?: number | null;
  /** Called after anything that changes the counts (pair, dismiss, unpair, upload). */
  onReceiptsChanged?: () => void;
  /** Unmatched receipts as the queue sees them right now (pending undo windows excluded). */
  onLiveUnmatchedChange?: (count: number | null) => void;
}

/**
 * Receipts mode of the Transactions page: the match queue, and "Matched this week" to skim and
 * undo what was paired (mostly automatically).
 */
export function ReceiptsWorkbench({
  user,
  onViewChange,
  onLogout,
  modeSwitch,
  unmatched = null,
  onReceiptsChanged,
  onLiveUnmatchedChange,
}: Props) {
  const { toast } = useToast();
  const [view, setView] = useState<ReceiptsView>('queue');
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [business, setBusiness] = useState('all');
  const [reloadKey, setReloadKey] = useState(0);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [recent, setRecent] = useState<RecentMatch[] | null>(null);
  const [recentError, setRecentError] = useState<string | null>(null);
  const [recentKey, setRecentKey] = useState(0);
  const mountedRef = useRef(true);
  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  useEffect(() => {
    onLiveUnmatchedChange?.(business === 'all' && view === 'queue' ? remaining : null);
  }, [business, onLiveUnmatchedChange, remaining, view]);
  useEffect(() => () => onLiveUnmatchedChange?.(null), [onLiveUnmatchedChange]);

  useEffect(() => {
    listBusinesses().then(setBusinesses).catch(() => setBusinesses([]));
  }, []);

  // Loaded up front so the tab can show its count.
  useEffect(() => {
    let cancelled = false;
    setRecentError(null);
    listRecentMatches({ days: 7, limit: 100, biz: business })
      .then((page) => !cancelled && setRecent(page.items))
      .catch((error: Error) => !cancelled && setRecentError(error.message));
    return () => {
      cancelled = true;
    };
  }, [business, recentKey]);

  const changed = useCallback(() => {
    onReceiptsChanged?.();
    setRecentKey((key) => key + 1);
  }, [onReceiptsChanged]);

  /** Poll one receipt until extraction (and the auto-match that follows it) has settled. */
  const waitForExtraction = async (receiptId: string) => {
    const deadline = Date.now() + EXTRACTION_POLL_TIMEOUT_MS;
    let delay = 1500;
    while (mountedRef.current && Date.now() < deadline) {
      await sleep(delay);
      delay = Math.min(Math.round(delay * 1.5), 5000);
      try {
        const receipt = await getReceipt(receiptId);
        if (receiptExtractionSettled(receipt)) return receipt;
      } catch {
        // Transient — keep polling until the deadline.
      }
    }
    return null;
  };

  const handleUpload = async (file: File) => {
    let receiptId: string;
    try {
      const selected = businesses.find((item) => item.id === business);
      ({ receiptId } = await uploadReceipt(file, selected?.dbId));
    } catch (error) {
      toast({ variant: 'destructive', title: 'Upload failed', description: error instanceof Error ? error.message : 'Try again.' });
      return;
    }
    toast({ title: 'Reading receipt…', description: 'It will pair itself if the match is clear.' });
    setReloadKey((key) => key + 1);
    onReceiptsChanged?.();
    const settled = await waitForExtraction(receiptId);
    if (!mountedRef.current || !settled) return;
    if (settled.transactionId) {
      toast({ variant: 'success', title: 'Receipt matched', description: `${receiptLabel(settled)} was paired automatically.` });
      changed();
    }
    setReloadKey((key) => key + 1);
  };

  const views: Array<{ id: ReceiptsView; label: string; count?: number | null }> = [
    { id: 'queue', label: 'Queue' },
    { id: 'matched', label: 'Matched this week', count: recent?.length ?? null },
  ];

  return (
    <AppShell
      currentView="transactions"
      onViewChange={onViewChange}
      onLogout={onLogout}
      user={user}
      onUploadReceipt={handleUpload}
      contextEyebrow="Workspace"
      contextTitle="Transactions"
      businesses={businesses}
      selectedBusiness={business}
      onBusinessChange={setBusiness}
    >
      <div className="flex min-w-0 flex-col gap-3">
        {modeSwitch}
        <div className="flex min-w-0 items-end justify-between gap-3 border-b border-ink2/10">
          <div role="tablist" aria-label="Receipts view" className="-mb-px flex min-w-0 gap-4">
            {views.map((item) => {
              const active = item.id === view;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setView(item.id)}
                  className={cn(
                    'inline-flex min-h-10 items-center gap-1.5 whitespace-nowrap border-b-2 px-0.5 text-sm font-bold transition-colors',
                    active ? 'border-ink text-ink' : 'border-transparent text-dim hover:text-ink',
                  )}
                >
                  {item.label}
                  {item.count != null && <span className="tabular-nums text-dim">({item.count})</span>}
                </button>
              );
            })}
          </div>
          {view === 'queue' && remaining != null && remaining > 0 && (
            <span className="mb-2.5 shrink-0 text-sm font-bold tabular-nums text-ink">
              {remaining} left
            </span>
          )}
        </div>

        {view === 'queue' ? (
          <MatchQueue
            biz={business}
            unmatched={business === 'all' ? unmatched : null}
            reloadKey={reloadKey}
            onRemainingChange={setRemaining}
            onChanged={changed}
          />
        ) : (
          <RecentMatches
            items={recent}
            error={recentError}
            onRetry={() => setRecentKey((key) => key + 1)}
            onUndone={() => {
              changed();
              setReloadKey((key) => key + 1);
            }}
          />
        )}
      </div>
    </AppShell>
  );
}
