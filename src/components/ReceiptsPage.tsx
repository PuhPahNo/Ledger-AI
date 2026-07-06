import { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Link2, Search, XCircle } from 'lucide-react';
import {
  attachReceipt,
  bulkDismissReceipts,
  dismissReceipt,
  listBusinesses,
  listReceiptCandidates,
  listReceipts,
  rematchReceipt,
  updateReceipt,
  uploadReceipt,
} from '@/api';
import type { AppView } from '@/types/navigation';
import type { Business, CurrentUser, ReceiptInboxItem, ReceiptMatchCandidate, ReceiptSource, Transaction } from '@/types/domain';
import { fmt$ } from '@/lib/format';
import { useToast } from '@/hooks/useToast';
import { AppShell } from './AppShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState } from '@/components/ui/empty-state';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ReceiptPreview } from './receipts/ReceiptPreview';
import {
  CandidateRow,
  Field,
  Metric,
  ReceiptEditForm,
  ReceiptRow,
  candidateMatchesQuery,
  formatCentsInput,
  parseDollarInput,
  receiptLabel,
  receiptNeedsDetails,
} from './receipts/ReceiptWorkbenchParts';

interface Props {
  user?: CurrentUser;
  onViewChange?: (view: AppView) => void;
  onLogout?: () => void;
}

export function ReceiptsPage({ user, onViewChange, onLogout }: Props) {
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
  const detailRef = useRef<HTMLDivElement>(null);

  const selectedReceipt = receipts.find((receipt) => receipt.id === selectedReceiptId) ?? receipts[0] ?? null;
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
  const gmailCount = receipts.filter((receipt) => receipt.source === 'gmail').length;
  const uploadCount = receipts.filter((receipt) => receipt.source === 'upload').length;

  useEffect(() => {
    listBusinesses().then(setBusinesses).catch((loadError: Error) => setError(loadError.message));
  }, []);

  useEffect(() => {
    setLoadingReceipts(true);
    setError('');
    listReceipts({
      status: 'pending',
      unmatched: true,
      biz: business,
      source,
      q: query || undefined,
      limit: 100,
    })
      .then((rows) => {
        setReceipts(rows);
        setCheckedIds(new Set());
        setSelectedReceiptId((current) => (current && rows.some((row) => row.id === current) ? current : rows[0]?.id ?? null));
      })
      .catch((loadError: Error) => setError(loadError.message))
      .finally(() => setLoadingReceipts(false));
  }, [business, query, refreshKey, source]);

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
  }, [selectedReceipt?.id, toast]);

  const refresh = () => setRefreshKey((key) => key + 1);

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

  const handleUpload = async (file: File) => {
    try {
      const selectedBusiness = businesses.find((item) => item.id === business);
      await uploadReceipt(file, selectedBusiness?.dbId);
      toast({ variant: 'success', title: 'Receipt queued', description: 'OCR and matching will run in the background.' });
      refresh();
    } catch (uploadError) {
      toast({
        variant: 'destructive',
        title: 'Upload failed',
        description: uploadError instanceof Error ? uploadError.message : 'Try again.',
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
      currentView="receipts"
      onViewChange={onViewChange}
      onLogout={onLogout}
      user={user}
      onUploadReceipt={handleUpload}
      contextEyebrow="Workspace"
      contextTitle="Receipts"
      search={{ query, onQueryChange: setQuery, placeholder: 'Search merchants…' }}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">Workspace</div>
            <h1 className="font-display text-3xl font-bold tracking-tight">Receipts</h1>
          </div>
          <Button variant="outline" onClick={refresh}>
            <Search className="h-4 w-4" />
            Refresh
          </Button>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <Metric label="Unmatched" value={String(receipts.length)} tone={receipts.length ? 'warning' : 'positive'} />
          <Metric label="Gmail" value={String(gmailCount)} />
          <Metric label="Manual uploads" value={String(uploadCount)} />
        </div>

        <div className="grid gap-3 rounded-xl border border-ink2/10 bg-paper p-3 shadow-sm md:grid-cols-[220px_180px_1fr]">
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
              <div className="divide-y divide-ink2/10">
                {receipts.map((receipt) => (
                  <ReceiptRow
                    key={receipt.id}
                    receipt={receipt}
                    active={receipt.id === selectedReceipt?.id}
                    busy={busyReceiptId === receipt.id}
                    checked={checkedIds.has(receipt.id)}
                    onSelect={() => setSelectedReceiptId(receipt.id)}
                    onDismiss={() => handleDismiss(receipt)}
                    onOpenFile={() => previewFile(receipt)}
                    onToggleChecked={() => toggleChecked(receipt.id)}
                  />
                ))}
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

                  {(selectedReceipt.extractionError || receiptNeedsDetails(selectedReceipt)) && (
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
