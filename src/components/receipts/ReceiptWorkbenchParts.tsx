import type { ReactNode } from 'react';
import { Check, Eye, FileText, XCircle } from 'lucide-react';
import type { ReceiptInboxItem, ReceiptMatchCandidate } from '@/types/domain';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { fmt$ } from '@/lib/format';
import { cn } from '@/lib/cn';

export function ReceiptRow({
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
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge variant={receipt.source === 'gmail' ? 'secondary' : 'muted'} className="whitespace-nowrap">
            {receipt.source}
          </Badge>
          {receiptNeedsDetails(receipt) && (
            <Badge variant="warning" className="whitespace-nowrap">Needs details</Badge>
          )}
        </div>
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

export function ReceiptEditForm({
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
          Save & find matches
        </Button>
      </div>
    </div>
  );
}

export function CandidateRow({
  candidate,
  disabled,
  onPair,
}: {
  candidate: ReceiptMatchCandidate;
  disabled: boolean;
  onPair: () => void;
}) {
  const { transaction } = candidate;
  return (
    <div className="grid gap-3 rounded-lg border border-ink2/10 bg-paper p-3 shadow-sm md:grid-cols-[minmax(0,1fr)_150px_auto]">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="truncate font-bold" title={transaction.merchant}>{transaction.merchant}</div>
          <MatchBadge score={candidate.score} />
          {candidate.suggested && (
            <Badge variant={candidate.wouldAutoAttach ? 'success' : 'secondary'}>
              {candidate.wouldAutoAttach ? 'Auto-safe' : 'Best match'}
            </Badge>
          )}
          {candidate.ambiguous && <Badge variant="warning">Ambiguous</Badge>}
        </div>
        <div className="mt-1 flex flex-wrap gap-2 text-xs text-dim">
          <span>{transaction.date}</span>
          <span>{transaction.cat}</span>
          <span>{transaction.src}</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {reasonBadges(candidate.reasons).map((reason) => (
            <span key={reason.label} className="rounded-full bg-cream px-2 py-0.5 text-[10px] font-bold text-dim">
              {reason.label} {reason.value}
            </span>
          ))}
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

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label className="font-mono text-[10px] uppercase tracking-wider text-dim">{label}</Label>
      {children}
    </div>
  );
}

export function Metric({
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
  const variant = score >= 0.82 ? 'success' : score >= 0.55 ? 'warning' : 'muted';
  return <Badge variant={variant}>{Math.round(score * 100)}%</Badge>;
}

export function receiptLabel(receipt: ReceiptInboxItem): string {
  return receipt.merchant || receipt.fileName || `${receipt.source} receipt`;
}

/** Matching needs both a total and a date — without them this receipt is stuck. */
export function receiptNeedsDetails(receipt: ReceiptInboxItem): boolean {
  return receipt.totalCents == null || !receipt.receiptDate;
}

export function candidateMatchesQuery(candidate: ReceiptMatchCandidate, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const transaction = candidate.transaction;
  return [transaction.merchant, transaction.cat, transaction.src, transaction.date]
    .some((value) => value.toLowerCase().includes(q));
}

function reasonBadges(reasons: Record<string, number | string>) {
  return [
    { key: 'amountScore', label: 'Amount' },
    { key: 'dateScore', label: 'Date' },
    { key: 'merchantScore', label: 'Merchant' },
    { key: 'cardScore', label: 'Card' },
    { key: 'businessScore', label: 'Business' },
  ].flatMap((item) => {
    const raw = reasons[item.key];
    if (typeof raw !== 'number') return [];
    return [{ label: item.label, value: `${Math.round(raw * 100)}%` }];
  });
}

export function formatCentsInput(cents?: number | null): string {
  return cents == null ? '' : (cents / 100).toFixed(2);
}

export function parseDollarInput(value: string): number | null | undefined {
  const normalized = value.replace(/[$,\s]/g, '');
  if (!normalized) return null;
  if (!/^\d+(\.\d{0,2})?$/.test(normalized)) return undefined;
  return Math.round(Number(normalized) * 100);
}
