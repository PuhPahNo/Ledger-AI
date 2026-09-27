import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { FileText, Link2, Search, XCircle } from 'lucide-react';
import {
  attachReceipt,
  bulkDismissReceipts,
  dismissReceipt,
  getReceipt,
  listBusinesses,
  listReceiptCandidates,
  listReceipts,
  receiptExtractionSettled,
  rematchReceipt,
  unpairReceipt,
  updateReceipt,
  uploadReceipt,
} from '@/api';
import type { NavigateFn } from '@/types/navigation';
import type { Business, CurrentUser, ReceiptInboxItem, ReceiptMatchCandidate, ReceiptSource, Transaction } from '@/types/domain';
import { fmt$ } from '@/lib/format';
import { useToast } from '@/hooks/useToast';
import { AppShell } from '../AppShell';
import { Button } from '@/components/ui/button';
import { ToastAction } from '@/components/ui/toast';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState } from '@/components/ui/empty-state';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ReceiptPreview } from './ReceiptPreview';
import {
  CandidateRow,
  Field,
  ReceiptEditForm,
  ReceiptRow,
  candidateMatchesQuery,
  formatCentsInput,
  parseDollarInput,
  receiptLabel,
  receiptNeedsDetails,
} from './ReceiptWorkbenchParts';

const PAGE_SIZE = 100;
const EXTRACTION_POLL_TIMEOUT_MS = 90_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Props {
  user?: CurrentUser;
  onViewChange?: NavigateFn;
  onLogout?: () => void;
  /** The Transactions | Receipts segmented control, rendered above the workbench. */
  modeSwitch?: ReactNode;
  /** Called after anything that changes the unmatched count (pair, dismiss, upload). */
  onReceiptsChanged?: () => void;
}

function groupReceiptsByMonth(receipts: ReceiptInboxItem[]): Array<{ month: string; rows: ReceiptInboxItem[] }> {
  const groups: Array<{ month: string; rows: ReceiptInboxItem[] }> = [];
  for (const receipt of receipts) {
    const month = (receipt.receiptDate ?? receipt.createdAt).slice(0, 7);
    const current = groups[groups.length - 1];
    if (current && current.month === month) current.rows.push(receipt);
    else groups.push({ month, rows: [receipt] });
  }
  return groups;
}

function monthLabel(month: string): string {
  const date = new Date(`${month}-01T00:00:00`);
  if (Number.isNaN(date.getTime())) return month;
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/**
 * Receipts mode of the Transactions page: unmatched receipts on the left, preview / pairing
 * on the right. (Phase 2 redesigns this; it was the standalone Receipts page.)
 */
export function ReceiptsWorkbench({ user, onViewChange, onLogout, modeSwitch, onReceiptsChanged }: Props) {
  const { toast } = useToast();
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [business, setBusiness] = useState('all');
  const [source, setSource] = useState<ReceiptSource | 'all'>('all');
  const [query, setQuery] = useState('');
  const [receipts, setReceipts] = useState<ReceiptInboxItem[]>([]);
  const [selectedReceiptId, setSelectedReceiptId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<ReceiptMatchCandidate[]>([]);
  const [candidateQuery, setCandidateQuery] = useState('');
  const [loadingReceipts, setLoadingReceipts] = useState(true);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [busyReceiptId, setBusyReceiptId] = useState<string | null>(null);
  const [savingReceiptId, setSavingReceiptId] = useState<string | null>(null);
  const [detailMode, setDetailMode] = useState<'receipt' | 'pair'>('receipt');
  const [receiptDraft, setReceiptDraft] = useState({ merchant: '', total: '', receiptDate: '' });
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [bulkDismissing, setBulkDismissing] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Uploads whose extraction is still running — shown as "Reading…" rather than "Needs details".
  const [extractingIds, setExtractingIds] = useState<Set<string>>(new Set());
  const [candidatesVersion, setCandidatesVersion] = useState(0);
  const detailRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  const selectedReceipt = receipts.find((receipt) => receipt.id === selectedReceiptId) ?? receipts[0] ?? null;
  const selectedReceiptIdRef = useRef<string | null>(null);
  selectedReceiptIdRef.current = selectedReceipt?.id ?? null;
  const selectedExtracting = selectedReceipt ? extractingIds.has(selectedReceipt.id) : false;
  const receiptForMatching = useMemo(() => {
    if (!selectedReceipt) return null;
    const draftTotal = parseDollarInput(receiptDraft.total);
    return {
      ...selectedReceipt,
      merchant: receiptDraft.merchant.trim() || null,
      receiptDate: receiptDraft.receiptDate || null,
      totalCents: draftTotal === undefined ? selectedReceipt.totalCents : draftTotal,
    };
  }, [receiptDraft, selectedReceipt]);
  const scoredCandidates = useMemo(() => (
    receiptForMatching
      ? candidates.filter((candidate) => candidateMatchesQuery(candidate, candidateQuery))
      : []
  ), [candidateQuery, candidates, receiptForMatching]);

  useEffect(() => {
    listBusinesses().then(setBusinesses).catch((loadError: Error) => setError(loadError.message));
  }, []);

  const listFilters = useMemo(() => ({
    status: 'pending' as const,
    unmatched: true,
    biz: business,
    source,
    q: query || undefined,
  }), [business, query, source]);

  useEffect(() => {
    setLoadingReceipts(true);
    setError('');
    listReceipts({ ...listFilters, limit: PAGE_SIZE })
      .then((rows) => {
        setReceipts(rows);
        setHasMore(rows.length === PAGE_SIZE);
        setCheckedIds(new Set());
        setSelectedReceiptId((current) => (current && rows.some((row) => row.id === current) ? current : rows[0]?.id ?? null));
      })
      .catch((loadError: Error) => setError(loadError.message))
      .finally(() => setLoadingReceipts(false));
  }, [listFilters, refreshKey]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const rows = await listReceipts({ ...listFilters, limit: PAGE_SIZE, offset: receipts.length });
      setReceipts((current) => {
        const seen = new Set(current.map((row) => row.id));
        return [...current, ...rows.filter((row) => !seen.has(row.id))];
      });
      setHasMore(rows.length === PAGE_SIZE);
    } catch (loadError) {
      toast({
        variant: 'destructive',
        title: 'Could not load more receipts',
        description: loadError instanceof Error ? loadError.message : 'Try again.',
      });
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    if (!selectedReceipt) {
      setCandidates([]);
      return;
    }
    // Receipts missing matchable details go straight to the pair tab, where the edit form is.
    setDetailMode(receiptNeedsDetails(selectedReceipt) ? 'pair' : 'receipt');
    setReceiptDraft({
      merchant: selectedReceipt.merchant ?? '',
      total: formatCentsInput(selectedReceipt.totalCents),
      receiptDate: selectedReceipt.receiptDate ?? '',
    });
    setCandidateQuery('');
  }, [selectedReceipt?.id]);

  useEffect(() => {
    if (!selectedReceipt) return;
    setLoadingCandidates(true);
    listReceiptCandidates(selectedReceipt.id)
      .then(setCandidates)
      .catch((loadError: Error) => toast({ variant: 'destructive', title: 'Could not load candidates', description: loadError.message }))
      .finally(() => setLoadingCandidates(false));
  }, [candidatesVersion, selectedReceipt?.id, toast]);

  const refresh = () => {
    setRefreshKey((key) => key + 1);
    onReceiptsChanged?.();
  };

  const replaceReceipt = (updated: ReceiptInboxItem) => {
    setReceipts((rows) => rows.map((receipt) => (receipt.id === updated.id ? updated : receipt)));
    setReceiptDraft({
      merchant: updated.merchant ?? '',
      total: formatCentsInput(updated.totalCents),
      receiptDate: updated.receiptDate ?? '',
    });
    return updated;
  };

  const saveReceiptEdits = async (receipt: ReceiptInboxItem, options: { silent?: boolean } = {}) => {
    const totalCents = parseDollarInput(receiptDraft.total);
    if (totalCents === undefined) {
      throw new Error('Enter a valid receipt total.');
    }
    setSavingReceiptId(receipt.id);
    try {
      const updated = await updateReceipt(receipt.id, {
        merchant: receiptDraft.merchant.trim() || null,
        receiptDate: receiptDraft.receiptDate || null,
        totalCents,
      });
      replaceReceipt(updated);
      if (!options.silent) toast({ variant: 'success', title: 'Receipt details saved' });
      return updated;
    } finally {
      setSavingReceiptId(null);
    }
  };

  // Save edits, then re-run matching — corrected details often unlock an auto-match, and
  // when they don't, refreshed candidates reflect the new total/date immediately.
  const handleSaveAndMatch = async (receipt: ReceiptInboxItem) => {
    try {
      const updated = await saveReceiptEdits(receipt, { silent: true });
      if (receiptNeedsDetails(updated)) {
        toast({ title: 'Details saved', description: 'Add a total and date to run matching.' });
        return;
      }
      const { matched } = await rematchReceipt(updated.id);
      if (matched?.attached) {
        toast({
          variant: 'success',
          title: 'Receipt matched',
          description: `${receiptLabel(updated)} paired with ${matched.transaction.merchant}.`,
        });
        setSelectedReceiptId(null);
        refresh();
        return;
      }
      toast({
        variant: 'success',
        title: 'Details saved',
        description: matched
          ? 'Best match suggested below — confirm to pair.'
          : 'No confident match yet — pick from the candidates below.',
      });
      const rows = await listReceiptCandidates(updated.id);
      setCandidates(rows);
    } catch (saveError) {
      toast({
        variant: 'destructive',
        title: 'Could not save receipt',
        description: saveError instanceof Error ? saveError.message : 'Try again.',
      });
    }
  };

  /** Poll one receipt until extraction (and the auto-match that follows it) has settled. */
  const waitForExtraction = async (receiptId: string): Promise<ReceiptInboxItem | null> => {
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

  const setExtracting = (receiptId: string, extracting: boolean) => {
    setExtractingIds((current) => {
      const next = new Set(current);
      if (extracting) next.add(receiptId);
      else next.delete(receiptId);
      return next;
    });
  };

  const handleUpload = async (file: File) => {
    let receiptId: string;
    try {
      const selectedBusiness = businesses.find((item) => item.id === business);
      ({ receiptId } = await uploadReceipt(file, selectedBusiness?.dbId));
    } catch (uploadError) {
      toast({
        variant: 'destructive',
        title: 'Upload failed',
        description: uploadError instanceof Error ? uploadError.message : 'Try again.',
      });
      return;
    }

    setExtracting(receiptId, true);
    setSelectedReceiptId(receiptId);
    refresh();
    const settled = await waitForExtraction(receiptId);
    if (!mountedRef.current) return;
    setExtracting(receiptId, false);
    if (!settled) {
      toast({ title: 'Still reading receipt', description: 'Details will appear here when processing finishes.' });
      return;
    }
    if (settled.transactionId) {
      toast({
        variant: 'success',
        title: 'Receipt matched',
        description: `${receiptLabel(settled)} was paired automatically.`,
        action: (
          <ToastAction altText="Unpair receipt" onClick={() => handleUnpair(settled)}>
            Unpair
          </ToastAction>
        ),
      });
      refresh();
      return;
    }
    // Still in the queue: show the extracted fields and fresh candidates in place.
    setReceipts((rows) => rows.map((row) => (row.id === settled.id ? settled : row)));
    if (selectedReceiptIdRef.current === settled.id) {
      setReceiptDraft({
        merchant: settled.merchant ?? '',
        total: formatCentsInput(settled.totalCents),
        receiptDate: settled.receiptDate ?? '',
      });
      setDetailMode(receiptNeedsDetails(settled) ? 'pair' : 'receipt');
      setCandidatesVersion((version) => version + 1);
    }
  };

  const handleUnpair = async (receipt: ReceiptInboxItem) => {
    try {
      await unpairReceipt(receipt.id);
      toast({ title: 'Receipt unpaired', description: `${receiptLabel(receipt)} is back in the queue.` });
      if (mountedRef.current) {
        setSelectedReceiptId(receipt.id);
        refresh();
      }
    } catch (unpairError) {
      toast({
        variant: 'destructive',
        title: 'Could not unpair receipt',
        description: unpairError instanceof Error ? unpairError.message : 'Try again.',
      });
    }
  };

  const handlePair = async (receipt: ReceiptInboxItem, transaction: Transaction) => {
    setBusyReceiptId(receipt.id);
    try {
      const updatedReceipt = await saveReceiptEdits(receipt, { silent: true });
      await attachReceipt(transaction.id, updatedReceipt.id);
      toast({ variant: 'success', title: 'Receipt paired', description: `${receiptLabel(updatedReceipt)} matched to ${transaction.merchant}.` });
      setSelectedReceiptId(null);
      refresh();
    } catch (pairError) {
      toast({
        variant: 'destructive',
        title: 'Could not pair receipt',
        description: pairError instanceof Error ? pairError.message : 'Try again.',
      });
    } finally {
      setBusyReceiptId(null);
    }
  };

  const toggleChecked = (receiptId: string) => {
    setCheckedIds((current) => {
      const next = new Set(current);
      if (next.has(receiptId)) next.delete(receiptId);
      else next.add(receiptId);
      return next;
    });
  };

  const handleBulkDismiss = async () => {
    if (checkedIds.size === 0) return;
    setBulkDismissing(true);
    try {
      const result = await bulkDismissReceipts([...checkedIds]);
      toast({ variant: 'success', title: `Dismissed ${result.dismissed} receipt${result.dismissed === 1 ? '' : 's'}` });
      setCheckedIds(new Set());
      setSelectedReceiptId(null);
      refresh();
    } catch (dismissError) {
      toast({
        variant: 'destructive',
        title: 'Could not dismiss receipts',
        description: dismissError instanceof Error ? dismissError.message : 'Try again.',
      });
    } finally {
      setBulkDismissing(false);
    }
  };

  const handleDismiss = async (receipt: ReceiptInboxItem) => {
    setBusyReceiptId(receipt.id);
    try {
      await dismissReceipt(receipt.id);
      toast({ variant: 'success', title: 'Receipt dismissed', description: receiptLabel(receipt) });
      setSelectedReceiptId(null);
      refresh();
    } catch (dismissError) {
      toast({
        variant: 'destructive',
        title: 'Could not dismiss receipt',
        description: dismissError instanceof Error ? dismissError.message : 'Try again.',
      });
    } finally {
      setBusyReceiptId(null);
    }
  };

  // Bring the preview/detail panel into view when a receipt is chosen (it can be above the
  // current scroll position when selecting from the bottom of a long list).
  useEffect(() => {
    if (selectedReceiptId) {
      detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [selectedReceiptId]);

  const previewFile = (receipt: ReceiptInboxItem) => setSelectedReceiptId(receipt.id);

  return (
    <AppShell
      currentView="transactions"
      onViewChange={onViewChange}
      onLogout={onLogout}
      user={user}
      onUploadReceipt={handleUpload}
      contextEyebrow="Workspace"
      contextTitle="Transactions"
      search={{ query, onQueryChange: setQuery, placeholder: 'Search merchants…' }}
    >
      <div className="flex flex-col gap-4">
        {modeSwitch}
        <div className="grid items-end gap-3 rounded-xl border border-ink2/10 bg-paper p-3 shadow-sm md:grid-cols-[220px_180px_1fr_auto]">
          <Field label="Business">
            <Select value={business} onValueChange={setBusiness}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All businesses</SelectItem>
                {businesses.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Source">
            <Select value={source} onValueChange={(value) => setSource(value as ReceiptSource | 'all')}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All sources</SelectItem>
                <SelectItem value="gmail">Gmail</SelectItem>
                <SelectItem value="upload">Manual upload</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Search">
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Merchant, file, business" />
          </Field>
          <Button variant="outline" onClick={refresh}>
            <Search className="h-4 w-4" />
            Refresh
          </Button>
        </div>

        {error ? (
          <div className="rounded-xl border border-coral/30 bg-coral/10 p-4 text-sm font-bold text-coral-ink">{error}</div>
        ) : (
          <div className="grid gap-3 xl:grid-cols-[minmax(320px,420px)_minmax(0,1fr)]">
            <div className="overflow-hidden rounded-xl border border-ink2/10 bg-paper shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink2/10 px-4 py-3">
                <h2 className="font-display text-xl font-bold">Unmatched receipts</h2>
                {checkedIds.size > 0 && (
                  <Button variant="outline" size="sm" disabled={bulkDismissing} onClick={handleBulkDismiss}>
                    <XCircle className="h-3.5 w-3.5" />
                    Dismiss {checkedIds.size} selected
                  </Button>
                )}
              </div>
              <div className="max-h-[70vh] overflow-y-auto">
                {groupReceiptsByMonth(receipts).map((group) => (
                  <div key={group.month}>
                    <div className="sticky top-0 z-10 flex items-baseline justify-between gap-3 border-b border-ink2/10 bg-cream/95 px-4 py-1.5 backdrop-blur">
                      <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-dim">
                        {monthLabel(group.month)}
                      </span>
                      <span className="text-[11px] tabular-nums text-dim">
                        {group.rows.length} receipt{group.rows.length === 1 ? '' : 's'}
                      </span>
                    </div>
                    <div className="divide-y divide-ink2/10">
                      {group.rows.map((receipt) => (
                        <ReceiptRow
                          key={receipt.id}
                          receipt={receipt}
                          active={receipt.id === selectedReceipt?.id}
                          busy={busyReceiptId === receipt.id}
                          extracting={extractingIds.has(receipt.id)}
                          checked={checkedIds.has(receipt.id)}
                          onSelect={() => setSelectedReceiptId(receipt.id)}
                          onDismiss={() => handleDismiss(receipt)}
                          onOpenFile={() => previewFile(receipt)}
                          onToggleChecked={() => toggleChecked(receipt.id)}
                        />
                      ))}
                    </div>
                  </div>
                ))}
                {hasMore && !loadingReceipts && (
                  <div className="border-t border-ink2/10 p-3 text-center">
                    <Button variant="ghost" size="sm" disabled={loadingMore} onClick={loadMore}>
                      {loadingMore ? 'Loading…' : 'Load more'}
                    </Button>
                  </div>
                )}
              </div>
              {loadingReceipts && <div className="p-6 text-center text-sm text-dim">Loading receipts...</div>}
              {!loadingReceipts && receipts.length === 0 && (
                <div className="p-4">
                  <EmptyState title="No unmatched receipts" icon={<FileText className="h-5 w-5" />} />
                </div>
              )}
            </div>

            <div ref={detailRef} className="overflow-hidden rounded-xl border border-ink2/10 bg-paper shadow-sm scroll-mt-4">
              {selectedReceipt ? (
                <Tabs value={detailMode} onValueChange={(value) => setDetailMode(value as 'receipt' | 'pair')}>
                  <div className="flex flex-wrap items-start gap-3 border-b border-ink2/10 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">
                        {selectedReceipt.source} · {selectedReceipt.businessName ?? selectedReceipt.biz}
                      </div>
                      <h2 className="truncate font-display text-xl font-bold">{receiptLabel(selectedReceipt)}</h2>
                      <div className="mt-1 flex flex-wrap gap-2 text-sm text-dim">
                        {selectedReceipt.receiptDate && <span>{selectedReceipt.receiptDate}</span>}
                        {selectedReceipt.totalCents != null && <span>{fmt$(selectedReceipt.totalCents / 100)}</span>}
                        {selectedExtracting && <span>Reading receipt…</span>}
                        {selectedReceipt.confidence != null && <span>{Math.round(selectedReceipt.confidence * 100)}% OCR</span>}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busyReceiptId === selectedReceipt.id}
                      onClick={() => handleDismiss(selectedReceipt)}
                    >
                      <XCircle className="h-4 w-4" />
                      Dismiss
                    </Button>
                  </div>

                  {!selectedExtracting && (selectedReceipt.extractionError || receiptNeedsDetails(selectedReceipt)) && (
                    <div className="border-b border-coral/30 bg-coral/10 px-4 py-2 text-xs font-bold text-coral-ink">
                      {selectedReceipt.extractionError
                        ?? 'Missing a total or date — fill them in under Pair, then Save & find matches.'}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2 border-b border-ink2/10 bg-[hsl(var(--color-sunken))] px-4 py-2">
                    <TabsList>
                      <TabsTrigger value="receipt">Receipt</TabsTrigger>
                      <TabsTrigger value="pair">Pair</TabsTrigger>
                    </TabsList>
                  </div>

                  <TabsContent value="receipt" className="m-0">
                    <ReceiptPreview
                      receipt={selectedReceipt}
                      className="h-[calc(100vh-330px)] min-h-[650px] border-0"
                    />
                  </TabsContent>

                  <TabsContent value="pair" className="m-0">
                    <div className="grid gap-4 p-4">
                      <ReceiptEditForm
                        draft={receiptDraft}
                        saving={savingReceiptId === selectedReceipt.id}
                        onDraftChange={setReceiptDraft}
                        onSave={() => handleSaveAndMatch(selectedReceipt)}
                      />

                      <div className="grid gap-3 rounded-lg border border-ink2/10 bg-[hsl(var(--color-sunken))] p-3">
                        <Field label="Candidate search">
                          <Input value={candidateQuery} onChange={(event) => setCandidateQuery(event.target.value)} placeholder="Merchant, category, account" />
                        </Field>
                        <div className="text-xs text-dim">Candidates use Ledger AI's amount/date/card/merchant scoring policy.</div>
                      </div>

                      <div className="grid gap-2">
                        {scoredCandidates.map((candidate) => (
                          <CandidateRow
                            key={candidate.transaction.id}
                            candidate={candidate}
                            disabled={busyReceiptId === selectedReceipt.id || savingReceiptId === selectedReceipt.id}
                            onPair={() => handlePair(selectedReceipt, candidate.transaction)}
                          />
                        ))}
                      </div>
                      {loadingCandidates && <div className="p-6 text-center text-sm text-dim">Loading candidates...</div>}
                      {!loadingCandidates && scoredCandidates.length === 0 && (
                        <div className="p-4">
                          <EmptyState title="No candidate transactions" icon={<Link2 className="h-5 w-5" />} />
                        </div>
                      )}
                    </div>
                  </TabsContent>
                </Tabs>
              ) : (
                <div className="p-4">
                  <EmptyState title="Select a receipt" icon={<FileText className="h-5 w-5" />} />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
