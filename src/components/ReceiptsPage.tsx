import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Check, Eye, FileText, Link2, Search, XCircle } from 'lucide-react';
import {
  attachReceipt,
  dismissReceipt,
  listBusinesses,
  listReceipts,
  listTransactions,
  updateReceipt,
  uploadReceipt,
} from '@/api';
import type { AppView } from '@/types/navigation';
import type { Business, CurrentUser, ReceiptInboxItem, ReceiptSource, Transaction } from '@/types/domain';
import { fmt$ } from '@/lib/format';
import { cn } from '@/lib/cn';
import { useToast } from '@/hooks/useToast';
import { AppShell } from './AppShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ReceiptPreview } from './receipts/ReceiptPreview';

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
  const [candidates, setCandidates] = useState<Transaction[]>([]);
  const [candidateQuery, setCandidateQuery] = useState('');
  const [candidateFrom, setCandidateFrom] = useState(defaultFrom());
  const [candidateTo, setCandidateTo] = useState(today());
  const [loadingReceipts, setLoadingReceipts] = useState(true);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [busyReceiptId, setBusyReceiptId] = useState<string | null>(null);
  const [savingReceiptId, setSavingReceiptId] = useState<string | null>(null);
  const [detailMode, setDetailMode] = useState<'receipt' | 'pair'>('receipt');
  const [receiptDraft, setReceiptDraft] = useState({ merchant: '', total: '', receiptDate: '' });
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
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
      ? candidates
        .map((transaction) => ({ transaction, score: scoreCandidate(receiptForMatching, transaction) }))
        .sort((a, b) => b.score - a.score)
      : []
  ), [candidates, receiptForMatching]);
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
    setDetailMode('receipt');
    setReceiptDraft({
      merchant: selectedReceipt.merchant ?? '',
      total: formatCentsInput(selectedReceipt.totalCents),
      receiptDate: selectedReceipt.receiptDate ?? '',
    });
    const window = candidateWindow(selectedReceipt);
    setCandidateQuery('');
    setCandidateFrom(window.from);
    setCandidateTo(window.to);
  }, [selectedReceipt?.id]);

  useEffect(() => {
    if (!selectedReceipt) return;
    setLoadingCandidates(true);
    listTransactions({
      biz: selectedReceipt.biz === 'all' ? 'all' : selectedReceipt.biz,
      q: candidateQuery || undefined,
      from: candidateFrom || undefined,
      to: candidateTo || undefined,
      receipts: ['missing', 'pending'],
      direction: 'operating-outflow',
      sort: 'date',
      dir: 'desc',
      limit: 50,
    })
      .then(setCandidates)
      .catch((loadError: Error) => toast({ variant: 'destructive', title: 'Could not load candidates', description: loadError.message }))
      .finally(() => setLoadingCandidates(false));
  }, [candidateFrom, candidateQuery, candidateTo, selectedReceipt?.id, toast]);

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
              <div className="border-b border-ink2/10 px-4 py-3">
                <h2 className="font-display text-xl font-bold">Unmatched receipts</h2>
              </div>
              <div className="divide-y divide-ink2/10">
                {receipts.map((receipt) => (
                  <ReceiptRow
                    key={receipt.id}
                    receipt={receipt}
                    active={receipt.id === selectedReceipt?.id}
                    busy={busyReceiptId === receipt.id}
                    onSelect={() => setSelectedReceiptId(receipt.id)}
                    onDismiss={() => handleDismiss(receipt)}
                    onOpenFile={() => previewFile(receipt)}
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
                        onSave={() => saveReceiptEdits(selectedReceipt).catch((saveError: Error) => {
                          toast({ variant: 'destructive', title: 'Could not save receipt', description: saveError.message });
                        })}
                      />

                      <div className="grid gap-3 rounded-lg border border-ink2/10 bg-[hsl(var(--color-sunken))] p-3 lg:grid-cols-[minmax(260px,1fr)_160px_160px]">
                        <Field label="Candidate search">
                          <Input value={candidateQuery} onChange={(event) => setCandidateQuery(event.target.value)} placeholder="Merchant, category, account" />
                        </Field>
                        <Field label="From">
                          <Input type="date" value={candidateFrom} onChange={(event) => setCandidateFrom(event.target.value)} />
                        </Field>
                        <Field label="To">
                          <Input type="date" value={candidateTo} onChange={(event) => setCandidateTo(event.target.value)} />
                        </Field>
                      </div>

                      <div className="grid gap-2">
                        {scoredCandidates.map(({ transaction, score }) => (
                          <CandidateRow
                            key={transaction.id}
                            transaction={transaction}
                            score={score}
                            disabled={busyReceiptId === selectedReceipt.id || savingReceiptId === selectedReceipt.id}
                            onPair={() => handlePair(selectedReceipt, transaction)}
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

function ReceiptRow({
  receipt,
  active,
  busy,
  onSelect,
  onDismiss,
  onOpenFile,
}: {
  receipt: ReceiptInboxItem;
  active: boolean;
  busy: boolean;
  onSelect: () => void;
  onDismiss: () => void;
  onOpenFile: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') onSelect();
      }}
      className={cn(
        'grid w-full cursor-pointer gap-2 px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20',
        active ? 'bg-lemon/20' : 'hover:bg-cream/70',
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-cream">
          <FileText className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-bold">{receiptLabel(receipt)}</div>
          <div className="truncate text-xs text-dim">{receipt.fileName ?? receipt.source}</div>
        </div>
        <Badge variant={receipt.source === 'gmail' ? 'secondary' : 'muted'} className="shrink-0 whitespace-nowrap">{receipt.source}</Badge>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-dim">
        {receipt.businessName && <span>{receipt.businessName}</span>}
        {receipt.uploadedBy && <span>Uploaded by {receipt.uploadedBy}</span>}
        {receipt.receiptDate && <span>{receipt.receiptDate}</span>}
        {receipt.totalCents != null && <span className="font-bold text-ink">{fmt$(receipt.totalCents / 100)}</span>}
      </div>
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={(event) => { event.stopPropagation(); onOpenFile(); }}>
          <Eye className="h-3.5 w-3.5" />
          Preview
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={(event) => { event.stopPropagation(); onDismiss(); }}>
          <XCircle className="h-3.5 w-3.5" />
          Dismiss
        </Button>
      </div>
    </div>
  );
}

function ReceiptEditForm({
  draft,
  saving,
  onDraftChange,
  onSave,
}: {
  draft: { merchant: string; total: string; receiptDate: string };
  saving: boolean;
  onDraftChange: (draft: { merchant: string; total: string; receiptDate: string }) => void;
  onSave: () => void;
}) {
  return (
    <div className="grid gap-3 rounded-lg border border-ink2/10 bg-paper p-3 shadow-sm lg:grid-cols-[minmax(240px,1fr)_160px_170px_auto]">
      <Field label="Merchant">
        <Input
          value={draft.merchant}
          onChange={(event) => onDraftChange({ ...draft, merchant: event.target.value })}
          placeholder="Merchant"
        />
      </Field>
      <Field label="Receipt total">
        <Input
          value={draft.total}
          onChange={(event) => onDraftChange({ ...draft, total: event.target.value })}
          inputMode="decimal"
          placeholder="0.00"
        />
      </Field>
      <Field label="Receipt date">
        <Input
          type="date"
          value={draft.receiptDate}
          onChange={(event) => onDraftChange({ ...draft, receiptDate: event.target.value })}
        />
      </Field>
      <div className="flex items-end">
        <Button variant="outline" className="w-full" disabled={saving} onClick={onSave}>
          Save edits
        </Button>
      </div>
    </div>
  );
}

function CandidateRow({
  transaction,
  score,
  disabled,
  onPair,
}: {
  transaction: Transaction;
  score: number;
  disabled: boolean;
  onPair: () => void;
}) {
  return (
    <div className="grid gap-3 rounded-lg border border-ink2/10 bg-paper p-3 shadow-sm md:grid-cols-[minmax(0,1fr)_150px_auto]">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="truncate font-bold" title={transaction.merchant}>{transaction.merchant}</div>
          <MatchBadge score={score} />
        </div>
        <div className="mt-1 flex flex-wrap gap-2 text-xs text-dim">
          <span>{transaction.date}</span>
          <span>{transaction.cat}</span>
          <span>{transaction.src}</span>
        </div>
      </div>
      <div className="self-center text-left md:text-right">
        <div className="font-display text-lg font-bold tabular-nums">{fmt$(transaction.amount)}</div>
      </div>
      <div className="flex items-center justify-start md:justify-end">
        <Button disabled={disabled} onClick={onPair}>
          <Check className="h-4 w-4" />
          Pair
        </Button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label className="font-mono text-[10px] uppercase tracking-wider text-dim">{label}</Label>
      {children}
    </div>
  );
}

function Metric({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'positive' | 'warning';
}) {
  return (
    <div className={cn(
      'rounded-lg border px-3 py-2 shadow-sm',
      tone === 'positive' && 'border-sage/40 bg-sage/10 text-sage-ink',
      tone === 'warning' && 'border-coral/40 bg-coral/10 text-coral-ink',
      tone === 'default' && 'border-ink2/10 bg-paper',
    )}>
      <div className="font-mono text-[10px] uppercase tracking-wider text-dim">{label}</div>
      <div className="font-display text-xl font-bold tabular-nums">{value}</div>
    </div>
  );
}

function MatchBadge({ score }: { score: number }) {
  const variant = score >= 82 ? 'success' : score >= 55 ? 'warning' : 'muted';
  return <Badge variant={variant}>{Math.round(score)}%</Badge>;
}

function receiptLabel(receipt: ReceiptInboxItem): string {
  return receipt.merchant || receipt.fileName || `${receipt.source} receipt`;
}

function candidateWindow(receipt: ReceiptInboxItem): { from: string; to: string } {
  if (!receipt.receiptDate) return { from: defaultFrom(), to: today() };
  const date = new Date(`${receipt.receiptDate}T00:00:00`);
  const from = new Date(date);
  from.setDate(from.getDate() - 7);
  const to = new Date(date);
  to.setDate(to.getDate() + 7);
  return { from: isoDate(from), to: isoDate(to) };
}

function scoreCandidate(receipt: ReceiptInboxItem, transaction: Transaction): number {
  const amount = receipt.totalCents == null ? 0.35 : amountScore(receipt.totalCents, transaction.amountCents ?? Math.round(transaction.amount * 100));
  const date = receipt.receiptDate ? dateScore(receipt.receiptDate, transaction.date) : 0.5;
  const merchant = merchantScore(receipt.merchant ?? '', transaction.merchant);
  return Math.round(((amount * 0.5) + (merchant * 0.3) + (date * 0.2)) * 100);
}

function amountScore(receiptCents: number, transactionCents: number): number {
  const txn = Math.abs(transactionCents);
  const delta = Math.abs(Math.abs(receiptCents) - txn);
  if (delta <= 2) return 1;
  const tolerance = Math.max(100, txn * 0.02);
  return Math.max(0, 1 - delta / tolerance);
}

function dateScore(receiptDate: string, transactionDate: string): number {
  const deltaDays = Math.abs((Date.parse(receiptDate) - Date.parse(transactionDate)) / 86_400_000);
  if (deltaDays <= 1) return 1;
  if (deltaDays > 7) return 0;
  return Math.max(0, 1 - deltaDays / 7);
}

function merchantScore(receiptMerchant: string, transactionMerchant: string): number {
  const a = tokens(receiptMerchant);
  const b = tokens(transactionMerchant);
  if (!a.size || !b.size) return 0.5;
  const overlap = [...a].filter((token) => b.has(token)).length;
  const union = new Set([...a, ...b]).size;
  return overlap / union;
}

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((token) => token.length > 1));
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaultFrom(): string {
  const start = new Date();
  start.setMonth(start.getMonth() - 3);
  return start.toISOString().slice(0, 10);
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatCentsInput(cents?: number | null): string {
  return cents == null ? '' : (cents / 100).toFixed(2);
}

function parseDollarInput(value: string): number | null | undefined {
  const normalized = value.replace(/[$,\s]/g, '');
  if (!normalized) return null;
  if (!/^\d+(\.\d{0,2})?$/.test(normalized)) return undefined;
  return Math.round(Number(normalized) * 100);
}
