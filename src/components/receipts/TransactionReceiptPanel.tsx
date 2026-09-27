import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { CheckCircle2, ExternalLink, FileText, Loader2, Mail, MinusCircle, Undo2, Unlink, Upload } from 'lucide-react';
import { attachReceipt, getReceipt, receiptFileUrl, unpairReceipt } from '@/api';
import {
  findReceiptInGmail,
  getWaiverEvidence,
  unwaiveReceipt,
  uploadReceiptToTransaction,
  waiveReceipt,
} from '@/api/receiptWorkflow';
import type { ReceiptInboxItem, ReceiptStatus, Transaction } from '@/types/domain';
import type { FindInGmailResult, GmailHit, WaiverEvidence } from '@/types/receiptWorkflow';
import { useToast } from '@/hooks/useToast';
import { cn } from '@/lib/cn';
import { fmt$ } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ReasonChips, centsLabel, relativeTime, shortDate } from './MatchParts';
import { receiptLabel } from './ReceiptWorkbenchParts';
import { isEditableTarget } from './queueState';

export interface ReceiptSlot {
  receiptId: string | null;
  status: ReceiptStatus;
  /** The receipt just attached, when the action returned it (saves a refetch). */
  receipt?: ReceiptInboxItem | null;
}

interface Props {
  transaction: Transaction;
  receiptId: string | null;
  status: ReceiptStatus;
  /** Details of the attached receipt when already known. */
  receipt?: ReceiptInboxItem | null;
  businessName?: string;
  /** The transaction's receipt changed on the server (attach, unpair, waive, unwaive). */
  onChange: (next: ReceiptSlot) => void;
}

/**
 * The receipt block of the transaction drawer: the attached receipt (View / Unpair), why a
 * waived transaction needs none (Undo waiver), or — when one is missing — Upload (picker, drop,
 * paste), Find in Gmail, and No receipt needed (optionally always for this merchant).
 */
export function TransactionReceiptPanel({ transaction, receiptId, status, receipt, businessName, onChange }: Props) {
  if (receiptId) {
    return (
      <AttachedReceipt
        receiptId={receiptId}
        known={receipt?.id === receiptId ? receipt : null}
        onUnpaired={() => onChange({ receiptId: null, status: 'missing' })}
      />
    );
  }
  if (status === 'waived') {
    return <WaivedReceipt transaction={transaction} onChange={onChange} />;
  }
  if (status === 'missing') {
    return <MissingReceipt transaction={transaction} businessName={businessName} onChange={onChange} />;
  }
  return null;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-2" aria-label={title}>
      <Label>{title}</Label>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Attached
// ---------------------------------------------------------------------------------------------

function AttachedReceipt({ receiptId, known, onUnpaired }: { receiptId: string; known: ReceiptInboxItem | null; onUnpaired: () => void }) {
  const { toast } = useToast();
  const [receipt, setReceipt] = useState<ReceiptInboxItem | null>(known);
  const [unpairing, setUnpairing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (known) {
      setReceipt(known);
      return;
    }
    setReceipt(null);
    getReceipt(receiptId)
      .then((row) => !cancelled && setReceipt(row))
      .catch(() => undefined); // View still works without the details.
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receiptId]);

  const unpair = async () => {
    setUnpairing(true);
    try {
      await unpairReceipt(receiptId);
      toast({ title: 'Receipt unpaired', description: 'It is back in the Receipts queue and won’t be re-paired here.' });
      onUnpaired();
    } catch (error) {
      toast({ variant: 'destructive', title: 'Could not unpair receipt', description: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setUnpairing(false);
    }
  };

  return (
    <Section title="Receipt">
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-ink2/10 p-2">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-cream">
          <FileText className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-bold">{receipt ? receiptLabel(receipt) : 'Attached receipt'}</div>
          {receipt && (receipt.receiptDate || receipt.totalCents != null) && (
            <div className="truncate text-xs text-dim">
              {[receipt.receiptDate ? shortDate(receipt.receiptDate) : null, receipt.totalCents != null ? centsLabel(receipt.totalCents) : null]
                .filter(Boolean)
                .join(' · ')}
            </div>
          )}
        </div>
        <div className="flex gap-1">
          <Button asChild variant="outline" size="sm">
            <a href={receiptFileUrl(receiptId)} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-3.5 w-3.5" />
              View
            </a>
          </Button>
          <Button variant="ghost" size="sm" disabled={unpairing} onClick={unpair} title="Detach this receipt">
            <Unlink className="h-3.5 w-3.5" />
            Unpair
          </Button>
        </div>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// Waived
// ---------------------------------------------------------------------------------------------

function evidenceText(evidence: WaiverEvidence): string {
  switch (evidence.kind) {
    case 'threshold':
      return `Rule: ${evidence.label}`;
    case 'merchant':
    case 'category':
      return `Rule: ${evidence.label.replace(/^(Merchant|Category): /, (_, kind: string) => `${kind.toLowerCase()} is `)}`;
    case 'manual':
      return 'Marked by hand';
    case 'tracking_cutoff':
      return 'Before receipt tracking started';
    default:
      return evidence.label || 'Reason not recorded';
  }
}

function WaivedReceipt({ transaction, onChange }: { transaction: Transaction; onChange: (next: ReceiptSlot) => void }) {
  const { toast } = useToast();
  const [evidence, setEvidence] = useState<WaiverEvidence | null | undefined>(undefined);
  const [undoing, setUndoing] = useState(false);
  const [attachAnyway, setAttachAnyway] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setEvidence(undefined);
    getWaiverEvidence(transaction.id)
      .then((row) => !cancelled && setEvidence(row))
      .catch(() => !cancelled && setEvidence(null));
    return () => {
      cancelled = true;
    };
  }, [transaction.id]);

  const undo = async () => {
    setUndoing(true);
    try {
      await unwaiveReceipt(transaction.id);
      toast({ title: 'Receipt needed again', description: `${transaction.merchant} is back on the missing-receipts list.` });
      onChange({ receiptId: null, status: 'missing' });
    } catch (error) {
      toast({ variant: 'destructive', title: 'Could not undo waiver', description: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setUndoing(false);
    }
  };

  return (
    <Section title="Receipt">
      <div className="grid gap-2 rounded-md border border-ink2/10 p-3">
        <div className="flex items-start gap-2">
          <MinusCircle className="mt-0.5 h-4 w-4 shrink-0 text-dim" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-bold">No receipt needed</div>
            {evidence === undefined ? (
              <Skeleton className="mt-1 h-3 w-40" />
            ) : (
              <div className="text-xs text-dim">
                {evidence ? evidenceText(evidence) : 'Reason not recorded'}
                {evidence?.createdAt && ` · ${relativeTime(evidence.createdAt)}`}
              </div>
            )}
            {evidence?.note && <div className="mt-1 text-xs text-dim">“{evidence.note}”</div>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={undoing} onClick={undo}>
            <Undo2 className="h-3.5 w-3.5" />
            Undo waiver
          </Button>
          {!attachAnyway && (
            <Button variant="ghost" size="sm" onClick={() => setAttachAnyway(true)}>
              <Upload className="h-3.5 w-3.5" />
              Attach one anyway
            </Button>
          )}
        </div>
        {evidence && evidence.kind !== 'manual' && (
          <p className="text-[11px] text-dim">Undo reopens only this transaction. Manage rules in Settings → Receipt rules.</p>
        )}
        {attachAnyway && <UploadDropzone transaction={transaction} onAttached={onChange} />}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// Missing
// ---------------------------------------------------------------------------------------------

function MissingReceipt({
  transaction,
  businessName,
  onChange,
}: {
  transaction: Transaction;
  businessName?: string;
  onChange: (next: ReceiptSlot) => void;
}) {
  const [panel, setPanel] = useState<'none' | 'gmail' | 'waive'>('none');
  return (
    <Section title="Receipt">
      <UploadDropzone transaction={transaction} onAttached={onChange} listenForPaste />
      <div className="grid gap-2 sm:grid-cols-2">
        <Button variant={panel === 'gmail' ? 'secondary' : 'outline'} onClick={() => setPanel('gmail')}>
          <Mail className="h-4 w-4 shrink-0" />
          Find in Gmail
        </Button>
        <Button variant={panel === 'waive' ? 'secondary' : 'outline'} onClick={() => setPanel(panel === 'waive' ? 'none' : 'waive')}>
          <MinusCircle className="h-4 w-4 shrink-0" />
          No receipt needed
        </Button>
      </div>
      {panel === 'gmail' && <GmailSearch transaction={transaction} onAttached={onChange} />}
      {panel === 'waive' && (
        <WaiveForm transaction={transaction} businessName={businessName} onCancel={() => setPanel('none')} onWaived={onChange} />
      )}
    </Section>
  );
}

function UploadDropzone({
  transaction,
  onAttached,
  listenForPaste = false,
}: {
  transaction: Transaction;
  onAttached: (next: ReceiptSlot) => void;
  listenForPaste?: boolean;
}) {
  const { toast } = useToast();
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadingRef = useRef(false);

  const upload = async (file: File) => {
    if (uploadingRef.current) return;
    uploadingRef.current = true;
    setUploading(true);
    try {
      const result = await uploadReceiptToTransaction(transaction.id, file);
      toast({
        variant: 'success',
        title: 'Receipt attached',
        description: result.processing ? `${file.name} — reading the details now.` : file.name,
      });
      onAttached({ receiptId: result.receipt?.id ?? result.transaction?.receiptId ?? null, status: 'matched', receipt: result.receipt });
    } catch (error) {
      toast({ variant: 'destructive', title: 'Upload failed', description: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      uploadingRef.current = false;
      setUploading(false);
    }
  };
  const uploadRef = useRef(upload);
  uploadRef.current = upload;

  // Paste a screenshot or file anywhere in the drawer (not while typing in a field).
  useEffect(() => {
    if (!listenForPaste) return;
    const onPaste = (event: ClipboardEvent) => {
      if (isEditableTarget(event.target)) return;
      const file = event.clipboardData?.files?.[0];
      if (!file) return;
      event.preventDefault();
      void uploadRef.current(file);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [listenForPaste]);

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const file = event.dataTransfer.files?.[0];
        if (file) void upload(file);
      }}
      className={cn(
        'flex flex-wrap items-center gap-3 rounded-lg border border-dashed p-3 transition-colors',
        dragging ? 'border-ink bg-cream' : 'border-ink2/25 bg-[hsl(var(--color-sunken))]',
      )}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-paper text-ink shadow-xs">
        {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
      </span>
      <div className="min-w-0 flex-1 text-xs text-dim">
        <div className="text-sm font-bold text-ink">{uploading ? 'Attaching…' : 'Upload receipt'}</div>
        {listenForPaste ? 'Drop a file here or paste a screenshot' : 'Drop a file here'}
      </div>
      <Button size="sm" disabled={uploading} onClick={() => inputRef.current?.click()}>
        Choose file
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*,application/pdf,.pdf,.html,.htm,.eml,.txt"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void upload(file);
        }}
      />
    </div>
  );
}

function GmailSearch({ transaction, onAttached }: { transaction: Transaction; onAttached: (next: ReceiptSlot) => void }) {
  const { toast } = useToast();
  const [result, setResult] = useState<FindInGmailResult | null>(null);
  const [error, setError] = useState('');
  const [pairingId, setPairingId] = useState<string | null>(null);
  const [runKey, setRunKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setError('');
    findReceiptInGmail(transaction.id)
      .then((body) => {
        if (cancelled) return;
        setResult(body);
        const paired = body.hits.find((hit) => hit.status === 'paired_here');
        if (body.paired && paired) {
          toast({ variant: 'success', title: 'Found in Gmail and attached', description: receiptLabel(paired.receipt) });
          onAttached({ receiptId: paired.receipt.id, status: 'matched', receipt: paired.receipt });
        }
      })
      .catch((searchError: Error) => !cancelled && setError(searchError.message));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transaction.id, runKey]);

  const pair = async (hit: GmailHit) => {
    setPairingId(hit.receipt.id);
    try {
      await attachReceipt(transaction.id, hit.receipt.id);
      toast({ variant: 'success', title: 'Receipt attached', description: receiptLabel(hit.receipt) });
      onAttached({ receiptId: hit.receipt.id, status: 'matched', receipt: hit.receipt });
    } catch (pairError) {
      toast({ variant: 'destructive', title: 'Could not attach receipt', description: pairError instanceof Error ? pairError.message : 'Try again.' });
    } finally {
      setPairingId(null);
    }
  };

  if (error) {
    return (
      <Callout tone="error">
        <div className="font-bold">Gmail search failed</div>
        <div>{error}</div>
        <Button variant="outline" size="sm" className="mt-2" onClick={() => setRunKey((key) => key + 1)}>Try again</Button>
      </Callout>
    );
  }

  if (!result) {
    return (
      <Callout>
        <div className="flex items-center gap-2 font-bold text-ink">
          <Loader2 className="h-4 w-4 animate-spin" />
          Searching Gmail…
        </div>
        <div>
          For {fmt$(Math.abs(transaction.amount))} or “{transaction.merchant}” around {shortDate(transaction.date)}.
        </div>
      </Callout>
    );
  }

  const candidates = result.hits.filter((hit) => hit.status === 'candidate');
  const reading = result.hits.filter((hit) => hit.status === 'processing' || hit.status === 'needs_details');
  const elsewhere = result.hits.filter((hit) => hit.status === 'paired_elsewhere');
  const failed = result.mailboxes.filter((mailbox) => mailbox.error);
  const searched = result.mailboxes.map((mailbox) => mailbox.email).filter(Boolean).join(', ');

  const queryLine = (
    <details className="text-[11px]">
      <summary className="cursor-pointer select-none text-dim hover:text-ink">Search used</summary>
      <code className="mt-1 block break-all rounded bg-paper px-2 py-1 font-mono text-[10px] text-ink">{result.search.query}</code>
    </details>
  );

  if (result.paired) {
    return (
      <Callout tone="success">
        <div className="flex items-center gap-2 font-bold"><CheckCircle2 className="h-4 w-4" />Found and attached</div>
        {queryLine}
      </Callout>
    );
  }

  if (result.mailboxes.length === 0) {
    return <Callout>No Gmail inbox is connected. Connect one in Settings → Businesses & accounts.</Callout>;
  }

  if (!result.searchable) {
    return <Callout>There’s no merchant name or amount to search Gmail with.</Callout>;
  }

  return (
    <Callout>
      {candidates.length > 0 ? (
        <>
          <div className="font-bold text-ink">
            Found {candidates.length === 1 ? 'a possible receipt' : `${candidates.length} possible receipts`} — check before pairing
          </div>
          <ul className="grid gap-2">
            {candidates.map((hit) => (
              <li key={hit.receipt.id} className="grid gap-2 rounded-md border border-ink2/10 bg-paper p-2">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-bold text-ink">{receiptLabel(hit.receipt)}</div>
                    <div className="text-xs text-dim">{shortDate(hit.receipt.receiptDate)} · {centsLabel(hit.receipt.totalCents)}</div>
                  </div>
                  <Button asChild variant="ghost" size="sm">
                    <a href={receiptFileUrl(hit.receipt.id)} target="_blank" rel="noopener noreferrer">View</a>
                  </Button>
                  <Button size="sm" disabled={pairingId != null} onClick={() => pair(hit)}>Pair</Button>
                </div>
                <ReasonChips reasons={hit.explanations} />
              </li>
            ))}
          </ul>
        </>
      ) : reading.length > 0 ? (
        <div>
          <span className="font-bold text-ink">Found {reading.length} email{reading.length === 1 ? '' : 's'} still being read.</span>{' '}
          If one matches, it pairs itself — check back in a minute.
        </div>
      ) : (
        <div>
          <span className="font-bold text-ink">Nothing found</span>
          {searched ? ` in ${searched}` : ''} between {shortDate(result.search.from)} and {shortDate(result.search.to)}.
        </div>
      )}
      {elsewhere.length > 0 && (
        <div>{elsewhere.length} matching receipt{elsewhere.length === 1 ? ' is' : 's are'} already attached to another transaction.</div>
      )}
      {failed.map((mailbox) => (
        <div key={mailbox.connectionId} className="text-coral-ink">{mailbox.email ?? 'A mailbox'} couldn’t be searched: {mailbox.error}</div>
      ))}
      {queryLine}
    </Callout>
  );
}

function WaiveForm({
  transaction,
  businessName,
  onCancel,
  onWaived,
}: {
  transaction: Transaction;
  businessName?: string;
  onCancel: () => void;
  onWaived: (next: ReceiptSlot) => void;
}) {
  const { toast } = useToast();
  const [always, setAlways] = useState(false);
  const [businessOnly, setBusinessOnly] = useState(false);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      const result = await waiveReceipt(transaction.id, { alwaysForMerchant: always, thisBusinessOnly: always && businessOnly });
      const extra = result.rule
        ? `Future ${transaction.merchant} charges won't need one${result.alsoWaived ? `; ${result.alsoWaived} other${result.alsoWaived === 1 ? '' : 's'} cleared too` : ''}.`
        : undefined;
      toast({ variant: 'success', title: 'Marked no receipt needed', description: extra });
      onWaived({ receiptId: null, status: 'waived' });
    } catch (error) {
      toast({ variant: 'destructive', title: 'Could not update receipt', description: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-2 rounded-lg border border-ink2/10 bg-[hsl(var(--color-sunken))] p-3">
      <CheckRow checked={always} onChange={setAlways} label={`Always for ${transaction.merchant}`} hint="Future charges from this merchant won't ask for a receipt." />
      {always && businessName && (
        <CheckRow checked={businessOnly} onChange={setBusinessOnly} label={`Only for ${businessName}`} className="pl-6" />
      )}
      <div className="flex gap-2 pt-1">
        <Button size="sm" disabled={saving} onClick={submit}>
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Mark no receipt needed
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function CheckRow({
  checked,
  onChange,
  label,
  hint,
  className,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint?: string;
  className?: string;
}) {
  return (
    <label className={cn('flex min-h-10 cursor-pointer items-start gap-2 py-1 sm:min-h-0', className)}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-ink"
      />
      <span className="min-w-0">
        <span className="block text-sm font-bold text-ink [overflow-wrap:anywhere]">{label}</span>
        {hint && <span className="block text-xs text-dim">{hint}</span>}
      </span>
    </label>
  );
}

function Callout({ tone = 'neutral', children }: { tone?: 'neutral' | 'success' | 'error'; children: ReactNode }) {
  return (
    <div
      className={cn(
        'grid gap-2 rounded-lg p-3 text-xs',
        tone === 'success' && 'bg-sage/20 text-sage-ink',
        tone === 'error' && 'bg-coral/10 text-coral-ink',
        tone === 'neutral' && 'bg-[hsl(var(--color-sunken))] text-dim',
      )}
      role="status"
    >
      {children}
    </div>
  );
}
