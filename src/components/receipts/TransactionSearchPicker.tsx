import { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { listTransactions } from '@/api';
import type { ReceiptInboxItem, Transaction } from '@/types/domain';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { shiftIsoDays } from '@/lib/dates';
import { fmt$ } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { TransactionFacts } from './MatchParts';
import { rankByAmount } from './matchFormat';

interface Props {
  receipt: ReceiptInboxItem;
  onPick: (transaction: Transaction) => void;
  onClose: () => void;
}

const WINDOW_DAYS = 10;

/**
 * "Search all transactions" for a receipt the matcher had nothing for. With no query it lists
 * outflows still missing a receipt around the receipt's date, closest amount first.
 */
export function TransactionSearchPicker({ receipt, onPick, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const debounced = useDebouncedValue(query.trim(), 250);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    const around = receipt.receiptDate && !debounced
      ? { from: shiftIsoDays(receipt.receiptDate, -WINDOW_DAYS), to: shiftIsoDays(receipt.receiptDate, WINDOW_DAYS) }
      : {};
    listTransactions({
      q: debounced || undefined,
      direction: 'outflow',
      receipts: ['missing', 'waived'],
      sort: 'date',
      dir: 'desc',
      limit: debounced ? 8 : 40,
      ...around,
    })
      .then((result) => {
        if (!cancelled) setRows(debounced ? result : rankByAmount(result, receipt.totalCents).slice(0, 8));
      })
      .catch((loadError: Error) => !cancelled && setError(loadError.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [debounced, receipt.receiptDate, receipt.totalCents]);

  return (
    <div className="grid gap-2 rounded-lg border border-ink2/15 bg-paper p-3 shadow-sm">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-dim" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onClose();
              if (event.key === 'Enter' && rows[0]) onPick(rows[0]);
            }}
            placeholder="Search merchant, amount, account…"
            aria-label="Search all transactions"
            className="pl-9"
          />
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close search">
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="text-[11px] text-dim">
        {debounced ? 'Outflows still needing a receipt' : `Needing a receipt within ${WINDOW_DAYS} days of this receipt, closest amount first`}
      </div>
      {error ? (
        <div className="rounded-md bg-coral/10 px-3 py-2 text-xs font-bold text-coral-ink">{error}</div>
      ) : loading ? (
        <div className="grid gap-2">
          {[0, 1, 2].map((key) => <Skeleton key={key} className="h-12" />)}
        </div>
      ) : rows.length === 0 ? (
        <div className="px-1 py-3 text-sm text-dim">No transactions found. Try a different search.</div>
      ) : (
        <ul className="grid max-h-80 gap-1 overflow-y-auto">
          {rows.map((transaction) => (
            <li key={transaction.id}>
              <button
                type="button"
                onClick={() => onPick(transaction)}
                className="flex min-h-12 w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-cream focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-bold text-ink">{transaction.merchant}</div>
                  <TransactionFacts transaction={transaction} />
                </div>
                <span className="shrink-0 font-display text-sm font-bold tabular-nums">{fmt$(Math.abs(transaction.amount))}</span>
                <span className="shrink-0 rounded-full border border-ink2/30 px-2.5 py-1 text-xs font-bold">Pair</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
