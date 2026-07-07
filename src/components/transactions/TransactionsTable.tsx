import { Fragment } from 'react';
import { ArrowDownRight, ArrowUpRight, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Account, Business, Transaction, TransactionRollup } from '@/types/domain';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TagChip } from '@/components/ui/tag-chip';
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
  /** Group rows under day headers. Only makes sense when rows are date-sorted. */
  groupByDate?: boolean;
}

interface DayGroup {
  date: string;
  rows: Transaction[];
  inflow: number;
  outflow: number;
}

function groupRowsByDay(rows: Transaction[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const row of rows) {
    const current = groups[groups.length - 1];
    if (current && current.date === row.date) {
      current.rows.push(row);
    } else {
      groups.push({ date: row.date, rows: [row], inflow: 0, outflow: 0 });
    }
    const group = groups[groups.length - 1];
    if (row.amount > 0) group.inflow += row.amount;
    else group.outflow += -row.amount;
  }
  return groups;
}

function dayLabel(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(date.getTime())) return isoDate;
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
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
  groupByDate = false,
}: TransactionsTableProps) {
  const selectable = Boolean(selectedIds && onToggleSelect);
  const allSelected = selectable && rows.length > 0 && rows.every((row) => selectedIds!.has(row.id));
  const columnCount = 6 + (selectable ? 1 : 0) + (groupByDate ? 0 : 1);

  const renderRow = (transaction: Transaction) => {
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
        {!groupByDate && (
          <TableCell className="whitespace-nowrap text-dim">
            <div className="font-mono text-[11px]">{transaction.date}</div>
          </TableCell>
        )}
        <TableCell>
          <div className="flex items-center gap-2">
            {transaction.amount > 0 ? (
              <ArrowDownRight className="h-3.5 w-3.5 shrink-0 text-sage-ink" />
            ) : (
              <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-dim" />
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="truncate font-bold text-ink" title={transaction.merchant}>
                  {transaction.merchant}
                </span>
                {transaction.tags?.slice(0, 2).map((tag) => (
                  <TagChip key={tag.id} name={tag.name} color={tag.color} className="shrink-0" />
                ))}
                {(transaction.tags?.length ?? 0) > 2 && (
                  <span className="shrink-0 text-[10px] font-bold text-dim">+{transaction.tags!.length - 2}</span>
                )}
              </div>
              {transaction.note && (
                <div className="truncate text-[11px] text-dim">{transaction.note}</div>
              )}
            </div>
          </div>
        </TableCell>
        <TableCell className="truncate">
          <span
            className="inline-flex items-center gap-1.5 text-xs"
            title={rowBusiness?.name ?? transaction.biz}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: rowBusiness?.color ?? '#ccc' }}
            />
            <span className="font-mono text-[11px] uppercase text-dim">
              {rowBusiness?.short ?? transaction.biz}
            </span>
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
  };

  const groups = groupByDate ? groupRowsByDay(rows) : [];

  return (
    <>
      <div className="max-h-[70vh] overflow-auto rounded-xl border border-ink2/10 bg-paper shadow-sm">
        {error ? (
          <div className="p-4 text-sm font-bold text-coral-ink">{error}</div>
        ) : (
          <>
            {/* min-w keeps the flexible Merchant column from collapsing to 0px when the
                fixed columns alone exceed the container; the wrapper scrolls instead. */}
            <Table className={cn('table-fixed', groupByDate ? 'min-w-[960px]' : 'min-w-[1060px]')}>
              <TableHeader className="sticky top-0 z-10 bg-paper">
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
                  {!groupByDate && <TableHead className="w-28">Date</TableHead>}
                  <TableHead>Merchant</TableHead>
                  <TableHead className="w-24">Business</TableHead>
                  <TableHead className="w-48">Account</TableHead>
                  <TableHead className="w-44">Category</TableHead>
                  <TableHead className="w-32 text-right">Amount</TableHead>
                  <TableHead className="w-28">Receipt</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groupByDate
                  ? groups.map((group) => (
                    <Fragment key={group.date}>
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={columnCount} className="bg-cream/60 py-1.5">
                          <div className="flex items-baseline justify-between gap-3">
                            <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-dim">
                              {dayLabel(group.date)}
                            </span>
                            <span className="text-[11px] tabular-nums text-dim">
                              {group.rows.length} txn{group.rows.length === 1 ? '' : 's'}
                              {group.outflow > 0 && ` · ${fmt$(group.outflow)} out`}
                              {group.inflow > 0 && ` · ${fmt$(group.inflow)} in`}
                            </span>
                          </div>
                        </TableCell>
                      </TableRow>
                      {group.rows.map(renderRow)}
                    </Fragment>
                  ))
                  : rows.map(renderRow)}
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
