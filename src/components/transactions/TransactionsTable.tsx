import { ArrowDownRight, ArrowUpRight, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Account, Business, Transaction, TransactionRollup } from '@/types/domain';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { accountLabel } from '@/lib/account';
import { categorySourceTag } from '@/lib/categorySource';
import { cn } from '@/lib/cn';
import { fmt$ } from '@/lib/format';
import { AccountTypeIcon, ReceiptPill } from './TransactionPageParts';

interface TransactionsTableProps {
  rows: Transaction[];
  rollup: TransactionRollup;
  offset: number;
  limit: number;
  loading: boolean;
  error: string;
  businessById: Map<string, Business>;
  accountById: Map<string, Account>;
  onSelectTransaction: (transaction: Transaction) => void;
  onPageChange: (offset: number) => void;
  /** Multi-select for bulk actions; omit to hide the checkbox column. */
  selectedIds?: Set<string>;
  onToggleSelect?: (transactionId: string) => void;
  onToggleSelectAll?: () => void;
}

export function TransactionsTable({
  rows,
  rollup,
  offset,
  limit,
  loading,
  error,
  businessById,
  accountById,
  onSelectTransaction,
  onPageChange,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
}: TransactionsTableProps) {
  const selectable = Boolean(selectedIds && onToggleSelect);
  const allSelected = selectable && rows.length > 0 && rows.every((row) => selectedIds!.has(row.id));
  return (
    <>
      <div className="overflow-x-auto rounded-xl border border-ink2/10 bg-paper shadow-sm">
        {error ? (
          <div className="p-4 text-sm font-bold text-coral-ink">{error}</div>
        ) : (
          <>
            {/* min-w keeps the flexible Merchant column from collapsing to 0px when the
                fixed columns alone exceed the container; the wrapper scrolls instead. */}
            <Table className="min-w-[1060px] table-fixed">
              <TableHeader>
                <TableRow>
                  {selectable && (
                    <TableHead className="w-10">
                      <input
                        type="checkbox"
                        aria-label="Select all visible transactions"
                        checked={allSelected}
                        onChange={() => onToggleSelectAll?.()}
                        className="h-3.5 w-3.5 accent-ink"
                      />
                    </TableHead>
                  )}
                  <TableHead className="w-28">Date</TableHead>
                  <TableHead>Merchant</TableHead>
                  <TableHead className="w-44">Business</TableHead>
                  <TableHead className="w-48">Account</TableHead>
                  <TableHead className="w-40">Category</TableHead>
                  <TableHead className="w-32 text-right">Amount</TableHead>
                  <TableHead className="w-28">Receipt</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((transaction) => {
                  const rowBusiness = businessById.get(transaction.biz);
                  const account = transaction.accountId ? accountById.get(transaction.accountId) : undefined;
                  return (
                    <TableRow
                      key={transaction.id}
                      onClick={() => onSelectTransaction(transaction)}
                      className="cursor-pointer"
                    >
                      {selectable && (
                        <TableCell onClick={(event) => event.stopPropagation()}>
                          <input
                            type="checkbox"
                            aria-label={`Select ${transaction.merchant}`}
                            checked={selectedIds!.has(transaction.id)}
                            onChange={() => onToggleSelect!(transaction.id)}
                            className="h-3.5 w-3.5 accent-ink"
                          />
                        </TableCell>
                      )}
                      <TableCell className="whitespace-nowrap text-dim">
                        <div className="font-mono text-[11px]">{transaction.date}</div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {transaction.amount > 0 ? (
                            <ArrowDownRight className="h-3.5 w-3.5 shrink-0 text-sage-ink" />
                          ) : (
                            <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-dim" />
                          )}
                          <div className="min-w-0">
                            <div className="truncate font-bold text-ink" title={transaction.merchant}>
                              {transaction.merchant}
                            </div>
                            {transaction.note && (
                              <div className="truncate text-[11px] text-dim">{transaction.note}</div>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="truncate">
                        <span className="inline-flex items-center gap-1.5 text-xs">
                          <span
                            className="h-1.5 w-1.5 rounded-full"
                            style={{ background: rowBusiness?.color ?? '#ccc' }}
                          />
                          <span className="text-dim">{rowBusiness?.name ?? transaction.biz}</span>
                        </span>
                      </TableCell>
                      <TableCell className="truncate text-dim">
                        {account ? (
                          <span className="inline-flex items-center gap-1.5">
                            <AccountTypeIcon kind={account.kind} className="h-3 w-3" />
                            <span className="truncate text-xs">{accountLabel(account)}</span>
                          </span>
                        ) : (
                          <span className="text-xs">{transaction.src}</span>
                        )}
                      </TableCell>
                      <TableCell className="truncate text-xs">
                        {transaction.cat}
                        {categorySourceTag(transaction.categorySource, transaction.categoryConfidence) && (
                          <span className="ml-1.5 rounded-full bg-cream px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-dim">
                            {categorySourceTag(transaction.categorySource, transaction.categoryConfidence)}
                          </span>
                        )}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'text-right font-display font-bold tabular-nums',
                          transaction.amount > 0 ? 'text-sage-ink' : 'text-ink',
                        )}
                      >
                        {fmt$(transaction.amount)}
                      </TableCell>
                      <TableCell>
                        <ReceiptPill status={transaction.receipt} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {loading && <div className="p-6 text-center text-sm text-dim">Loading transactions...</div>}
            {!loading && rows.length === 0 && (
              <div className="p-8">
                <EmptyState title="No transactions" description="No rows match the current filters." />
              </div>
            )}
          </>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between text-xs text-dim">
        <div>
          Showing {rollup.rows === 0 ? 0 : offset + 1}-{Math.min(offset + rows.length, rollup.rows)} of {rollup.rows}
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0 || loading}
            onClick={() => onPageChange(Math.max(0, offset - limit))}
          >
            <ChevronLeft className="h-3 w-3" />
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={offset + rows.length >= rollup.rows || loading}
            onClick={() => onPageChange(offset + limit)}
          >
            Next
            <ChevronRight className="h-3 w-3" />
          </Button>
        </div>
      </div>
    </>
  );
}
