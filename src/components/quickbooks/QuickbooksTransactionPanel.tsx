import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link2, Loader2, Paperclip, Unlink } from 'lucide-react';
import { getTransactionQuickbooks, linkQuickbooksTransaction, unlinkQuickbooksTransaction } from '@/api/quickbooks';
import type { QboEntityType, QboTransactionDetails, QboTransactionLink, QboTransactionSummary } from '@/types/quickbooks';
import { useToast } from '@/hooks/useToast';
import { paymentMethodLabel } from '@/lib/contractors';
import { parseLocalIsoDate } from '@/lib/dates';
import { fmt$ } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { hasQuickbooksConnection, loadQuickbooksStatus } from './useQuickbooksStatus';

const ENTITY_LABEL: Record<QboEntityType, string> = {
  Purchase: 'Expense',
  BillPayment: 'Bill payment',
  Bill: 'Bill',
  Deposit: 'Deposit',
  Transfer: 'Transfer',
  VendorCredit: 'Vendor credit',
};

function shortDate(iso: string): string {
  return parseLocalIsoDate(iso.slice(0, 10)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Transaction drawer section: the QuickBooks record this bank/card transaction is linked to
 * (payee, account, memo, attachments), with Unlink — or, when unlinked, nearby records to link.
 * Renders nothing when QuickBooks isn't connected (for `business`, when given) or when there's
 * nothing to show.
 */
export function QuickbooksTransactionPanel({ transactionId, business }: { transactionId: string; business?: string }) {
  const { toast } = useToast();
  const [details, setDetails] = useState<QboTransactionDetails | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'hidden' | 'error'>('loading');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    setDetails(null);
    loadQuickbooksStatus()
      .then(async (status) => {
        if (!hasQuickbooksConnection(status, business)) {
          if (!cancelled) setState('hidden');
          return;
        }
        const result = await getTransactionQuickbooks(transactionId);
        if (cancelled) return;
        setDetails(result);
        setState('ready');
      })
      .catch(() => !cancelled && setState('error'));
    return () => {
      cancelled = true;
    };
  }, [transactionId, business]);

  const unlink = async (link: QboTransactionLink) => {
    setBusy(link.linkId);
    try {
      setDetails(await unlinkQuickbooksTransaction(link.linkId));
      toast({ title: 'Unlinked from QuickBooks', description: "It won't be linked automatically again." });
    } catch (error) {
      toast({ variant: 'destructive', title: 'Unlink failed', description: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setBusy(null);
    }
  };

  const link = async (candidate: QboTransactionSummary) => {
    setBusy(candidate.id);
    try {
      setDetails(await linkQuickbooksTransaction({ transactionId, qboTransactionId: candidate.id }));
      toast({ variant: 'success', title: 'Linked to QuickBooks' });
    } catch (error) {
      toast({ variant: 'destructive', title: 'Link failed', description: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setBusy(null);
    }
  };

  if (state === 'hidden') return null;
  if (state === 'loading') {
    return (
      <Section>
        <Skeleton className="h-16" />
      </Section>
    );
  }
  if (state === 'error' || !details) {
    return (
      <Section>
        <p className="text-xs text-dim">Couldn't load the QuickBooks record.</p>
      </Section>
    );
  }
  if (!details.links.length && !details.candidates.length) return null;

  return (
    <Section>
      {details.links.map((row) => (
        <LinkedRecord key={row.linkId} link={row} busy={busy === row.linkId} onUnlink={() => void unlink(row)} />
      ))}
      {!details.links.length && details.candidates.length > 0 && (
        <div className="grid min-w-0 gap-1.5">
          <div className="text-xs text-dim">Not linked. Records with the same amount nearby:</div>
          <ul className="divide-y divide-ink2/10 rounded-lg border border-ink2/10">
            {details.candidates.map((candidate) => (
              <li key={candidate.id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-bold text-ink">{candidate.payeeName ?? ENTITY_LABEL[candidate.entityType]}</div>
                  <div className="text-dim">
                    {[
                      shortDate(candidate.txnDate),
                      fmt$(Math.abs(candidate.totalCents) / 100),
                      ENTITY_LABEL[candidate.entityType],
                      candidate.docNumber ? `#${candidate.docNumber}` : null,
                      candidate.memo,
                    ].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <Button variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => void link(candidate)}>
                  {busy === candidate.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
                  Link
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

function Section({ children }: { children: ReactNode }) {
  return (
    <section aria-label="QuickBooks" className="grid min-w-0 gap-2 [&>*]:min-w-0">
      <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">QuickBooks</div>
      {children}
    </section>
  );
}

function linkMethodText(link: QboTransactionLink): string {
  if (link.method === 'manual') return 'Linked by you';
  return link.confidence != null ? `Auto-linked · ${Math.round(link.confidence * 100)}% match` : 'Auto-linked';
}

function LinkedRecord({ link, busy, onUnlink }: { link: QboTransactionLink; busy: boolean; onUnlink: () => void }) {
  const qbo = link.qboTransaction;
  const payee = link.vendor?.name ?? qbo.payeeName;
  const accounts = link.expenseAccounts.filter((row) => row.name);
  const imported = link.attachments.filter((row) => row.receiptId).length;
  return (
    <div className="grid gap-2 rounded-lg border border-ink2/10 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate font-bold text-ink">{payee ?? 'No payee'}</span>
        {link.isContractor && <Badge variant="warning" className="px-2 py-0 text-[10px]">Contractor</Badge>}
        {link.vendor?.vendor1099 && !link.isContractor && <Badge variant="muted" className="px-2 py-0 text-[10px]">1099 vendor</Badge>}
        {qbo.deleted && <Badge variant="danger" className="px-2 py-0 text-[10px]">Deleted in QuickBooks</Badge>}
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-dim">Record</dt>
        <dd className="text-ink">
          {[
            ENTITY_LABEL[qbo.entityType],
            qbo.paymentMethod ? paymentMethodLabel(qbo.paymentMethod) : null,
            qbo.docNumber ? `#${qbo.docNumber}` : null,
            shortDate(qbo.txnDate),
          ].filter(Boolean).join(' · ')}
        </dd>
        {accounts.length > 0 && (
          <>
            <dt className="text-dim">{accounts.length === 1 ? 'Account' : 'Accounts'}</dt>
            <dd className="grid gap-0.5 text-ink">
              {accounts.map((row, index) => (
                <span key={`${row.qboAccountId ?? index}`} className="truncate">
                  {row.name}
                  {row.categoryName && row.categoryName !== row.name && <span className="text-dim"> → {row.categoryName}</span>}
                  {accounts.length > 1 && <span className="text-dim"> · {fmt$(Math.abs(row.amountCents) / 100)}</span>}
                </span>
              ))}
            </dd>
          </>
        )}
        {qbo.bankAccountName && (
          <>
            <dt className="text-dim">Paid from</dt>
            <dd className="truncate text-ink">{qbo.bankAccountName}</dd>
          </>
        )}
        {qbo.memo && (
          <>
            <dt className="text-dim">Memo</dt>
            <dd className="text-ink">{qbo.memo}</dd>
          </>
        )}
        {link.attachments.length > 0 && (
          <>
            <dt className="text-dim">Attachments</dt>
            <dd className="flex items-center gap-1 text-ink">
              <Paperclip className="h-3 w-3 text-dim" />
              {link.attachments.length}
              {imported > 0 && (
                <span className="text-dim">
                  · {imported === link.attachments.length ? `imported as receipt${imported > 1 ? 's' : ''}` : `${imported} imported as receipts`}
                </span>
              )}
            </dd>
          </>
        )}
      </dl>
      <div className="flex items-center justify-between gap-2 border-t border-ink2/10 pt-2">
        <span className="text-xs text-dim">{linkMethodText(link)}</span>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onUnlink}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unlink className="h-3.5 w-3.5" />}
          Unlink
        </Button>
      </div>
    </div>
  );
}
