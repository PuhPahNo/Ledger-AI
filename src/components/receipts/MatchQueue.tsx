import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, ChevronDown, Loader2, Pencil, RefreshCw, Search, SkipForward, XCircle } from 'lucide-react';
import { getReceipt, listExplainedCandidates, receiptExtractionSettled, rematchReceipt, updateReceipt } from '@/api';
import { dismissFromQueue, getMatchQueue, pairFromQueue } from '@/api/receiptWorkflow';
import type { ReceiptInboxItem, Transaction } from '@/types/domain';
import type { ExplainedMatchCandidate } from '@/types/receiptWorkflow';
import { useToast } from '@/hooks/useToast';
import { cn } from '@/lib/cn';
import { fmt$ } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ToastAction } from '@/components/ui/toast';
import { Kbd, ReasonChips, TransactionFacts, centsLabel, shortDate } from './MatchParts';
import { ReceiptPreview } from './ReceiptPreview';
import { Field, formatCentsInput, parseDollarInput, receiptLabel, receiptNeedsDetails } from './ReceiptWorkbenchParts';
import { TransactionSearchPicker } from './TransactionSearchPicker';
import {
  currentItem,
  initialQueueState,
  isEditableTarget,
  loadedReceiptIds,
  needsMore,
  queueKeyCommand,
  queueReducer,
  remainingCount,
  type PendingQueueAction,
  type QueueActionKind,
} from './queueState';

/** How long an action can be undone before it is sent to the server. Matches the toast. */
export const UNDO_WINDOW_MS = 6000;
const PAGE_SIZE = 20;

interface Props {
  biz?: string;
  /** Unmatched receipts per GET /receipts/counts (null until loaded). */
  unmatched: number | null;
  /** Bump to reload the queue (e.g. after an upload). */
  reloadKey?: number;
  onRemainingChange?: (remaining: number | null) => void;
  /** Something was paired/dismissed on the server — refresh counts and badges. */
  onChanged?: () => void;
}

interface Draft {
  merchant: string;
  total: string;
  receiptDate: string;
}

const draftFor = (receipt: ReceiptInboxItem): Draft => ({
  merchant: receipt.merchant ?? '',
  total: formatCentsInput(receipt.totalCents),
  receiptDate: receipt.receiptDate ?? '',
});

let actionSeq = 0;

/**
 * The receipt match queue: one receipt at a time, its top candidates with plain-language reasons,
 * and 1/2/3 · N · S · E · ←/→ · U as accelerators for the buttons. Actions apply instantly on
 * screen and reach the server after the undo window.
 */
export function MatchQueue({ biz, unmatched, reloadKey = 0, onRemainingChange, onChanged }: Props) {
  const { toast } = useToast();
  const [state, dispatch] = useReducer(queueReducer, initialQueueState);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>({ merchant: '', total: '', receiptDate: '' });
  const [saving, setSaving] = useState(false);
  const [searching, setSearching] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  // Focus the merchant field only when the user asked to edit (E / Edit), not when a receipt
  // missing details opens in edit mode — otherwise N/S would type into the field.
  const focusEditRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const merchantInputRef = useRef<HTMLInputElement>(null);
  const timers = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; run: () => void; dismissToast: () => void }>());
  const mountedRef = useRef(true);
  const loadingMoreRef = useRef(false);
  // One undo toast at a time: a new action replaces the previous toast (U still undoes in order).
  const toastRef = useRef<{ dismiss: () => void } | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const item = currentItem(state);
  const remaining = state.status === 'ready' ? remainingCount(state) : null;

  useEffect(() => {
    onRemainingChange?.(remaining);
  }, [onRemainingChange, remaining]);

  // ---- Loading --------------------------------------------------------------------------------

  const load = useCallback(() => {
    dispatch({ type: 'loading' });
    getMatchQueue({ limit: PAGE_SIZE, biz, skip: stateRef.current.skipped })
      .then((page) => mountedRef.current && dispatch({ type: 'loaded', page }))
      .catch((error: Error) => mountedRef.current && dispatch({ type: 'failed', error: error.message }));
  }, [biz]);

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  useEffect(() => {
    if (unmatched != null) dispatch({ type: 'counts', unmatched });
  }, [unmatched]);

  useEffect(() => {
    if (!needsMore(state) || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    getMatchQueue({ limit: PAGE_SIZE, biz, skip: loadedReceiptIds(state) })
      .then((page) => mountedRef.current && dispatch({ type: 'appended', page }))
      .catch(() => undefined)
      .finally(() => {
        loadingMoreRef.current = false;
      });
  }, [biz, state]);

  // New receipt on screen: reset per-receipt UI. Receipts missing details open straight in edit.
  const itemId = item?.receipt.id;
  useEffect(() => {
    setSearching(false);
    setPreviewOpen(false);
    if (item) setDraft(draftFor(item.receipt));
    setEditing(item?.blockedReason === 'missing_details');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  useEffect(() => {
    if (editing && focusEditRef.current) merchantInputRef.current?.focus();
    focusEditRef.current = false;
  }, [editing, itemId]);

  const startEdit = () => {
    focusEditRef.current = true;
    setEditing(true);
    merchantInputRef.current?.focus();
  };

  const focusQueue = () => containerRef.current?.focus({ preventScroll: true });

  // ---- Commit after the undo window -----------------------------------------------------------

  // Commits can finish after the queue unmounts (switching tabs flushes them): the parent still
  // needs to hear about them, so only the local dispatches are skipped then.
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  const commit = useCallback(async (action: PendingQueueAction) => {
    timers.current.delete(action.id);
    try {
      if (action.kind === 'pair' && action.transactionId) {
        await pairFromQueue(action.item.receipt.id, action.transactionId, { biz });
      } else {
        await dismissFromQueue(action.item.receipt.id, { biz });
      }
      if (mountedRef.current) dispatch({ type: 'settled', actionId: action.id });
      onChangedRef.current?.();
    } catch (error) {
      if (mountedRef.current) dispatch({ type: 'rollback', actionId: action.id });
      toast({
        variant: 'destructive',
        title: action.kind === 'pair' ? 'Could not pair receipt' : 'Could not dismiss receipt',
        description: `${receiptLabel(action.item.receipt)} is back in the queue. ${error instanceof Error ? error.message : ''}`.trim(),
      });
    }
  }, [biz, toast]);

  // Leaving the page (or the tab) sends anything still waiting out its undo window.
  useEffect(() => {
    const flush = () => {
      for (const [, entry] of timers.current) {
        clearTimeout(entry.timer);
        entry.run();
      }
      timers.current.clear();
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      mountedRef.current = false;
      flush();
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
  }, []);

  const undo = useCallback((actionId: string) => {
    const entry = timers.current.get(actionId);
    if (!entry) return;
    clearTimeout(entry.timer);
    timers.current.delete(actionId);
    entry.dismissToast();
    dispatch({ type: 'undo', actionId });
    setTimeout(focusQueue, 0);
  }, []);

  const act = (kind: QueueActionKind, transaction?: Transaction) => {
    if (!item) return;
    const id = `qa-${++actionSeq}`;
    const action: PendingQueueAction = {
      id,
      kind,
      item,
      transactionId: transaction?.id,
      label: transaction?.merchant,
      position: state.index,
    };
    dispatch({ type: 'act', action: { id, kind, transactionId: transaction?.id, label: transaction?.merchant } });
    toastRef.current?.dismiss();
    const handle = toast({
      duration: UNDO_WINDOW_MS,
      title: kind === 'pair' ? 'Paired' : 'Dismissed',
      description: kind === 'pair'
        ? `${receiptLabel(item.receipt)} → ${transaction?.merchant} ${transaction ? fmt$(Math.abs(transaction.amount)) : ''}`.trim()
        : `${receiptLabel(item.receipt)} — not a business receipt`,
      action: <ToastAction altText="Undo" onClick={() => undo(id)}>Undo</ToastAction>,
    });
    toastRef.current = handle;
    const run = () => void commit(action);
    timers.current.set(id, { timer: setTimeout(run, UNDO_WINDOW_MS), run, dismissToast: handle.dismiss });
    setEditing(false);
    setTimeout(focusQueue, 0);
  };

  const pairSlot = (slot: number) => {
    const candidate = item?.candidates[slot];
    if (candidate && !item?.blockedReason) act('pair', candidate.transaction);
  };

  const skip = () => {
    if (state.items.length < 2) {
      toast({ title: 'Nothing else in the queue', description: 'This is the only receipt left.' });
      return;
    }
    dispatch({ type: 'skip' });
    setTimeout(focusQueue, 0);
  };

  const go = (delta: number) => {
    dispatch({ type: 'go', delta });
    setTimeout(focusQueue, 0);
  };

  const lastPending = state.pending[state.pending.length - 1];

  // ---- Edit details ---------------------------------------------------------------------------

  const saveDetails = async () => {
    if (!item) return;
    const totalCents = parseDollarInput(draft.total);
    if (totalCents === undefined) {
      toast({ variant: 'destructive', title: 'Enter a valid total', description: 'e.g. 54.99' });
      return;
    }
    setSaving(true);
    try {
      const updated = await updateReceipt(item.receipt.id, {
        merchant: draft.merchant.trim() || null,
        totalCents,
        receiptDate: draft.receiptDate || null,
      });
      const receipt = { ...item.receipt, ...updated };
      if (receiptNeedsDetails(receipt)) {
        dispatch({ type: 'replace', item: { ...item, receipt, blockedReason: 'missing_details', candidates: [] } });
        toast({ title: 'Saved', description: 'Add both a total and a date to find matches.' });
        return;
      }
      const { matched } = await rematchReceipt(receipt.id);
      if (matched?.attached) {
        dispatch({ type: 'remove', receiptId: receipt.id });
        toast({ variant: 'success', title: 'Matched automatically', description: `${receiptLabel(receipt)} → ${matched.transaction.merchant}. Undo it under Matched this week.` });
        onChanged?.();
        return;
      }
      const candidates: ExplainedMatchCandidate[] = await listExplainedCandidates(receipt.id);
      dispatch({ type: 'replace', item: { ...item, receipt, blockedReason: null, candidates } });
      setEditing(false);
      setTimeout(focusQueue, 0);
    } catch (error) {
      toast({ variant: 'destructive', title: 'Could not save receipt', description: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setSaving(false);
    }
  };

  const cancelEdit = () => {
    if (item) setDraft(draftFor(item.receipt));
    setEditing(false);
    setTimeout(focusQueue, 0);
  };

  // Extraction still running: check once more on demand.
  const checkAgain = async () => {
    if (!item) return;
    setChecking(true);
    try {
      const receipt = await getReceipt(item.receipt.id);
      if (!receiptExtractionSettled(receipt)) {
        toast({ title: 'Still reading', description: 'Give it a few more seconds.' });
        return;
      }
      if (receipt.transactionId) {
        dispatch({ type: 'remove', receiptId: receipt.id });
        toast({ variant: 'success', title: 'Matched automatically', description: receiptLabel(receipt) });
        onChanged?.();
        return;
      }
      const blocked = receiptNeedsDetails(receipt);
      const candidates = blocked ? [] : await listExplainedCandidates(receipt.id);
      dispatch({ type: 'replace', item: { receipt, candidates, blockedReason: blocked ? 'missing_details' : null } });
    } catch (error) {
      toast({ variant: 'destructive', title: 'Could not refresh receipt', description: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setChecking(false);
    }
  };

  // ---- Keyboard -------------------------------------------------------------------------------

  const handlersRef = useRef({ pairSlot, act, skip, go, undo, startEdit, lastPending, item });
  handlersRef.current = { pairSlot, act, skip, go, undo, startEdit, lastPending, item };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const h = handlersRef.current;
      const command = queueKeyCommand({
        key: event.key,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        inEditable: isEditableTarget(event.target),
        overlayOpen: Boolean(document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')),
        candidateCount: h.item?.candidates.length ?? 0,
        blocked: Boolean(h.item?.blockedReason),
        hasItem: Boolean(h.item),
        canUndo: Boolean(h.lastPending),
      });
      if (!command) return;
      event.preventDefault();
      switch (command.type) {
        case 'pair':
          h.pairSlot(command.slot);
          break;
        case 'dismiss':
          h.act('dismiss');
          break;
        case 'skip':
          h.skip();
          break;
        case 'edit':
          h.startEdit();
          break;
        case 'prev':
          h.go(-1);
          break;
        case 'next':
          h.go(1);
          break;
        case 'undo':
          if (h.lastPending) h.undo(h.lastPending.id);
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // ---- Render ---------------------------------------------------------------------------------

  if (state.status === 'loading' && state.items.length === 0) return <QueueSkeleton />;

  if (state.status === 'error') {
    return (
      <EmptyState
        title="Couldn't load the match queue"
        description={state.error ?? 'Try again.'}
        icon={<XCircle className="h-5 w-5" />}
        action={<Button variant="outline" onClick={load}><RefreshCw className="h-4 w-4" />Retry</Button>}
      />
    );
  }

  if (!item) {
    return (
      <EmptyState
        className="py-16"
        title="All caught up"
        description="Every receipt is paired or dismissed. New receipts from Gmail and uploads land here, and confident ones pair themselves."
        icon={<CheckCircle2 className="h-6 w-6 text-sage-ink" />}
      />
    );
  }

  const { receipt, candidates, blockedReason } = item;
  const noCandidates = !blockedReason && candidates.length === 0;

  return (
    <div ref={containerRef} tabIndex={-1} className="grid gap-3 outline-none" aria-label="Receipt match queue">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        {/* Receipt */}
        <section className="min-w-0 overflow-hidden rounded-xl border border-ink2/10 bg-paper shadow-sm" aria-label="Receipt">
          <div className="grid gap-3 p-4">
            <div className="flex min-w-0 items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">
                  {sourceLabel(receipt.source)}{receipt.businessName ? ` · ${receipt.businessName}` : ''}
                </div>
                {!editing && (
                  <h2 className="truncate font-display text-2xl font-bold" title={receiptLabel(receipt)}>{receiptLabel(receipt)}</h2>
                )}
              </div>
              {!editing && (
                <Button variant="outline" size="sm" onClick={startEdit} aria-keyshortcuts="E">
                  <Pencil className="h-3.5 w-3.5" />
                  Edit
                  <Kbd className="hidden lg:inline-flex">E</Kbd>
                </Button>
              )}
            </div>

            {editing ? (
              <form
                className="grid gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveDetails();
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    cancelEdit();
                  }
                }}
              >
                <Field label="Merchant" htmlFor="queue-merchant">
                  <Input
                    id="queue-merchant"
                    ref={merchantInputRef}
                    value={draft.merchant}
                    onChange={(event) => setDraft({ ...draft, merchant: event.target.value })}
                    placeholder="Merchant"
                  />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Total" htmlFor="queue-total">
                    <Input
                      id="queue-total"
                      value={draft.total}
                      onChange={(event) => setDraft({ ...draft, total: event.target.value })}
                      inputMode="decimal"
                      placeholder="0.00"
                    />
                  </Field>
                  <Field label="Date" htmlFor="queue-date">
                    <Input
                      id="queue-date"
                      type="date"
                      value={draft.receiptDate}
                      onChange={(event) => setDraft({ ...draft, receiptDate: event.target.value })}
                    />
                  </Field>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="submit" disabled={saving}>
                    {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                    Save & find matches
                  </Button>
                  <Button type="button" variant="ghost" onClick={cancelEdit}>Cancel</Button>
                  <span className="hidden text-[11px] text-dim lg:inline">Enter to save · Esc to cancel</span>
                </div>
              </form>
            ) : (
              <dl className="grid grid-cols-3 gap-3">
                <Fact label="Total" value={centsLabel(receipt.totalCents)} strong missing={receipt.totalCents == null} />
                <Fact label="Date" value={shortDate(receipt.receiptDate)} missing={!receipt.receiptDate} />
                <Fact label="Read" value={receipt.confidence != null ? `${Math.round(receipt.confidence * 100)}%` : '—'} />
              </dl>
            )}

            {receipt.extractionError && !editing && (
              <div className="rounded-md bg-coral/10 px-3 py-2 text-xs font-bold text-coral-ink">{receipt.extractionError}</div>
            )}

            <Button
              variant="secondary"
              className="w-full lg:hidden"
              aria-expanded={previewOpen}
              onClick={() => setPreviewOpen((open) => !open)}
            >
              {previewOpen ? 'Hide receipt' : 'Show receipt'}
              <ChevronDown className={cn('h-4 w-4 transition-transform', previewOpen && 'rotate-180')} />
            </Button>
          </div>
          <div className={cn(previewOpen ? 'block' : 'hidden', 'border-t border-ink2/10 lg:block')}>
            <ReceiptPreview receipt={receipt} className="h-[60vh] min-h-[380px] lg:h-[calc(100vh-420px)] lg:min-h-[460px]" />
          </div>
        </section>

        {/* Candidates */}
        <section className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-3" aria-label="Matching transactions">
          {blockedReason === 'extraction_pending' ? (
            <StatusPanel
              icon={<Loader2 className="h-5 w-5 animate-spin" />}
              title="Still reading this receipt"
              detail="Matches appear once the total and date are read — usually a few seconds."
              action={<Button variant="outline" size="sm" disabled={checking} onClick={checkAgain}><RefreshCw className="h-3.5 w-3.5" />Check again</Button>}
            />
          ) : blockedReason === 'missing_details' ? (
            <StatusPanel
              icon={<Pencil className="h-5 w-5" />}
              title="Add the total and date"
              detail="They couldn't be read from the file. Fill them in on the left and matches will appear here."
            />
          ) : noCandidates ? (
            <StatusPanel
              icon={<Search className="h-5 w-5" />}
              title="No likely transaction"
              detail={`Nothing within a few days matches ${centsLabel(receipt.totalCents)}. Search everything, or dismiss it if it isn't a business receipt.`}
            />
          ) : (
            <>
              <div className="flex items-baseline justify-between gap-2 px-1">
                <h3 className="text-sm font-bold text-ink">Which transaction is this?</h3>
                <span className="text-[11px] text-dim">{candidates.length === 1 ? '1 match' : `Top ${candidates.length}`}</span>
              </div>
              <ol className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
                {candidates.map((candidate, index) => (
                  <li key={candidate.transaction.id}>
                    <CandidateCard
                      candidate={candidate}
                      slot={index + 1}
                      primary={index === 0}
                      receiptCents={receipt.totalCents}
                      onPair={() => pairSlot(index)}
                    />
                  </li>
                ))}
              </ol>
            </>
          )}

          {searching ? (
            <TransactionSearchPicker
              receipt={receipt}
              onPick={(transaction) => act('pair', transaction)}
              onClose={() => {
                setSearching(false);
                setTimeout(focusQueue, 0);
              }}
            />
          ) : (
            <Button
              variant={noCandidates ? 'default' : 'ghost'}
              className={cn('w-full sm:w-fit', !noCandidates && 'justify-self-start text-dim hover:text-ink')}
              onClick={() => setSearching(true)}
            >
              <Search className="h-4 w-4" />
              {candidates.length > 0 ? 'None of these? Search all transactions' : 'Search all transactions'}
            </Button>
          )}

          <div className="grid grid-cols-2 gap-2 border-t border-ink2/10 pt-3 sm:flex sm:flex-wrap sm:items-center">
            <Button variant="outline" onClick={() => act('dismiss')} aria-keyshortcuts="N" title="Not a business receipt — remove it from the queue">
              <XCircle className="h-4 w-4" />
              Dismiss
              <Kbd className="hidden lg:inline-flex">N</Kbd>
            </Button>
            <Button variant="outline" onClick={skip} aria-keyshortcuts="S" title="Come back to it later">
              <SkipForward className="h-4 w-4" />
              Skip
              <Kbd className="hidden lg:inline-flex">S</Kbd>
            </Button>
            <div className="col-span-2 flex items-center justify-between gap-1 sm:ml-auto sm:justify-end">
              <Button variant="ghost" size="icon" disabled={state.index === 0} onClick={() => go(-1)} aria-label="Previous receipt" aria-keyshortcuts="ArrowLeft">
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <span className="text-xs tabular-nums text-dim">
                {state.index + 1} of {state.items.length}{state.exhausted ? '' : '+'}
              </span>
              <Button variant="ghost" size="icon" disabled={state.index >= state.items.length - 1} onClick={() => go(1)} aria-label="Next receipt" aria-keyshortcuts="ArrowRight">
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </section>
      </div>

      <ShortcutHints canUndo={Boolean(lastPending)} />
    </div>
  );
}

function CandidateCard({
  candidate,
  slot,
  primary,
  receiptCents,
  onPair,
}: {
  candidate: ExplainedMatchCandidate;
  slot: number;
  /** The top candidate gets the solid button; the rest are outlined. */
  primary: boolean;
  receiptCents?: number | null;
  onPair: () => void;
}) {
  const { transaction } = candidate;
  const cents = Math.round(Math.abs(transaction.amount) * 100);
  const amountDiffers = receiptCents != null && Math.abs(cents - receiptCents) > 2;
  return (
    <div
      className={cn(
        'grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 rounded-xl border bg-paper p-3 shadow-sm transition-colors',
        candidate.suggested ? 'border-ink/30' : 'border-ink2/10',
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        <Kbd className="mt-0.5 hidden h-6 min-w-6 text-xs lg:inline-flex">{slot}</Kbd>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate font-bold text-ink" title={transaction.merchant}>{transaction.merchant}</span>
            {candidate.suggested && <Badge variant="secondary" className="px-2 py-0 text-[10px]">Best match</Badge>}
            {candidate.ambiguous && <Badge variant="warning" className="px-2 py-0 text-[10px]">Look-alike</Badge>}
          </div>
          <TransactionFacts transaction={transaction} className="mt-0.5" />
        </div>
        <div className="shrink-0 text-right">
          <div className={cn('font-display text-lg font-bold tabular-nums', amountDiffers && 'text-coral-ink')}>{fmt$(Math.abs(transaction.amount))}</div>
          <div className="text-[10px] tabular-nums text-dim" title="Matcher confidence">{Math.round(candidate.score * 100)}% match</div>
        </div>
      </div>
      <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:gap-3">
        <ReasonChips reasons={candidate.explanations} className="flex-1 lg:pl-9" />
        <Button
          variant={primary ? 'default' : 'outline'}
          className="w-full shrink-0 lg:h-8 lg:w-auto lg:px-4 lg:text-xs"
          onClick={onPair}
          aria-keyshortcuts={String(slot)}
        >
          Pair
          <span className="sr-only"> with {transaction.merchant}</span>
        </Button>
      </div>
    </div>
  );
}

function Fact({ label, value, strong, missing }: { label: string; value: string; strong?: boolean; missing?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="font-mono text-[10px] uppercase tracking-wider text-dim">{label}</dt>
      <dd className={cn('truncate tabular-nums', strong ? 'font-display text-lg font-bold' : 'text-sm font-bold', missing && 'text-coral-ink')}>
        {missing ? 'Missing' : value}
      </dd>
    </div>
  );
}

function StatusPanel({ icon, title, detail, action }: { icon: ReactNode; title: string; detail: string; action?: ReactNode }) {
  return (
    <div className="grid justify-items-start gap-2 rounded-xl border border-dashed border-ink2/20 bg-[hsl(var(--color-sunken))] p-5">
      <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-paper text-ink shadow-xs">{icon}</span>
      <div className="font-display text-lg font-bold text-ink">{title}</div>
      <p className="max-w-md text-sm text-dim">{detail}</p>
      {action}
    </div>
  );
}

function ShortcutHints({ canUndo }: { canUndo: boolean }) {
  const hints: Array<[string, string]> = [
    ['1–3', 'Pair'],
    ['N', 'Dismiss'],
    ['S', 'Skip'],
    ['E', 'Edit'],
    ['← →', 'Browse'],
  ];
  if (canUndo) hints.push(['U', 'Undo']);
  return (
    <div className="hidden flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px] text-dim lg:flex" aria-hidden>
      {hints.map(([key, label]) => (
        <span key={key} className="inline-flex items-center gap-1.5">
          <Kbd>{key}</Kbd>
          {label}
        </span>
      ))}
    </div>
  );
}

function QueueSkeleton() {
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]" aria-busy="true" aria-label="Loading match queue">
      <div className="grid gap-3 rounded-xl border border-ink2/10 bg-paper p-4 shadow-sm">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-7 w-48" />
        <div className="grid grid-cols-3 gap-3">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
        <Skeleton className="hidden h-[420px] lg:block" />
      </div>
      <div className="grid content-start gap-2">
        {[0, 1, 2].map((key) => <Skeleton key={key} className="h-32 rounded-xl" />)}
      </div>
    </div>
  );
}

function sourceLabel(source: ReceiptInboxItem['source']): string {
  switch (source) {
    case 'gmail':
      return 'From Gmail';
    case 'upload':
      return 'Uploaded';
    default:
      return String(source);
  }
}

