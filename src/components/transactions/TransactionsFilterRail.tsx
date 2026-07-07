import { Check, ChevronLeft, Filter } from 'lucide-react';
import type { Account, ReceiptStatus, Tag, TransactionDirection } from '@/types/domain';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { accountLabel } from '@/lib/account';
import { cn } from '@/lib/cn';
import { AccountTypeIcon, FacetGroup, today } from './TransactionPageParts';

type FilterGroup = 'accounts' | 'category' | 'tags' | 'receipt';

interface TransactionsFilterRailProps {
  railOpen: boolean;
  direction: TransactionDirection;
  visibleAccounts: Account[];
  accountIds: string[];
  categoryName: string;
  categoryOptions: string[];
  tags: Tag[];
  tagIds: string[];
  receipts: ReceiptStatus[];
  openGroups: Record<FilterGroup, boolean>;
  waiveBefore: string;
  waiving: boolean;
  onRailOpenChange: (open: boolean) => void;
  onDirectionChange: (direction: TransactionDirection) => void;
  onAccountToggle: (accountId: string) => void;
  onCategoryChange: (name: string) => void;
  onTagToggle: (tagId: string) => void;
  onReceiptToggle: (status: ReceiptStatus) => void;
  onToggleGroup: (group: FilterGroup) => void;
  onWaiveBeforeChange: (date: string) => void;
  onWaiveOld: () => void;
}

export function TransactionsFilterRail({
  railOpen,
  direction,
  visibleAccounts,
  accountIds,
  categoryName,
  categoryOptions,
  tags,
  tagIds,
  receipts,
  openGroups,
  waiveBefore,
  waiving,
  onRailOpenChange,
  onDirectionChange,
  onAccountToggle,
  onCategoryChange,
  onTagToggle,
  onReceiptToggle,
  onToggleGroup,
  onWaiveBeforeChange,
  onWaiveOld,
}: TransactionsFilterRailProps) {
  if (!railOpen) {
    return (
      <div className="hidden lg:block">
        <Button variant="outline" size="sm" onClick={() => onRailOpenChange(true)}>
          <Filter className="h-3.5 w-3.5" />
          Filters
        </Button>
      </div>
    );
  }

  return (
    <aside className="hidden w-[240px] shrink-0 rounded-xl border border-ink2/10 bg-paper p-3 shadow-sm lg:block">
      <div className="mb-2 flex items-center justify-between">
        <div className="font-mono text-[10px] font-medium uppercase tracking-wider text-dim">Filters</div>
        <button
          type="button"
          onClick={() => onRailOpenChange(false)}
          className="text-dim hover:text-ink"
          title="Collapse"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
      </div>

      <FacetGroup label="Direction" open onToggle={undefined}>
        <div className="grid grid-cols-2 gap-1">
          {([
            { value: 'all', label: 'All' },
            { value: 'outflow', label: 'Out' },
            { value: 'inflow', label: 'In' },
            { value: 'transfer', label: 'Transfer' },
          ] as const).map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => onDirectionChange(opt.value)}
              className={cn(
                'rounded-md px-2 py-1 text-xs font-bold transition-colors',
                direction === opt.value ? 'bg-inverse text-inverse-foreground' : 'bg-cream/40 text-ink hover:bg-cream',
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </FacetGroup>

      <FacetGroup
        label={`Accounts${accountIds.length ? ` · ${accountIds.length}` : ''}`}
        open={openGroups.accounts}
        onToggle={() => onToggleGroup('accounts')}
      >
        <div className="max-h-48 overflow-y-auto">
          {visibleAccounts.length === 0 && <div className="px-2 text-xs text-dim">No accounts</div>}
          {visibleAccounts.map((account) => {
            const checked = accountIds.includes(account.id);
            return (
              <button
                key={account.id}
                type="button"
                onClick={() => onAccountToggle(account.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-cream/60',
                  !account.enabled && 'opacity-60',
                )}
              >
                <span className={cn(
                  'flex h-3.5 w-3.5 items-center justify-center rounded border',
                  checked ? 'border-inverse bg-inverse text-inverse-foreground' : 'border-ink2/25',
                )}>
                  {checked && <Check className="h-2.5 w-2.5" />}
                </span>
                <AccountTypeIcon kind={account.kind} className="h-3 w-3 text-dim" />
                <span className="flex-1 truncate font-medium text-ink">{accountLabel(account)}</span>
                {account.mask && <span className="font-mono text-[10px] text-dim">·{account.mask}</span>}
              </button>
            );
          })}
        </div>
      </FacetGroup>

      <FacetGroup label="Category" open={openGroups.category} onToggle={() => onToggleGroup('category')}>
        <div className="max-h-48 overflow-y-auto">
          <button
            type="button"
            onClick={() => onCategoryChange('all')}
            className={cn(
              'flex w-full items-center justify-between rounded-md px-2 py-1 text-xs font-medium transition-colors',
              categoryName === 'all' ? 'bg-cream text-ink' : 'text-ink hover:bg-cream/60',
            )}
          >
            All
            {categoryName === 'all' && <Check className="h-3 w-3" />}
          </button>
          {categoryOptions.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => onCategoryChange(name)}
              className={cn(
                'flex w-full items-center justify-between rounded-md px-2 py-1 text-xs font-medium transition-colors',
                categoryName === name ? 'bg-cream text-ink' : 'text-ink hover:bg-cream/60',
              )}
            >
              <span className="truncate">{name}</span>
              {categoryName === name && <Check className="h-3 w-3 shrink-0" />}
            </button>
          ))}
        </div>
      </FacetGroup>

      {tags.length > 0 && (
        <FacetGroup
          label={`Tags${tagIds.length ? ` · ${tagIds.length}` : ''}`}
          open={openGroups.tags}
          onToggle={() => onToggleGroup('tags')}
        >
          <div className="max-h-48 overflow-y-auto">
            {tags.map((tag) => {
              const checked = tagIds.includes(tag.id);
              return (
                <button
                  key={tag.id}
                  type="button"
                  onClick={() => onTagToggle(tag.id)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-cream/60"
                >
                  <span className={cn(
                    'flex h-3.5 w-3.5 items-center justify-center rounded border',
                    checked ? 'border-inverse bg-inverse text-inverse-foreground' : 'border-ink2/25',
                  )}>
                    {checked && <Check className="h-2.5 w-2.5" />}
                  </span>
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: tag.color }} />
                  <span className="flex-1 truncate font-medium text-ink">{tag.name}</span>
                  {tag.txnCount != null && tag.txnCount > 0 && (
                    <span className="font-mono text-[10px] text-dim">{tag.txnCount}</span>
                  )}
                </button>
              );
            })}
          </div>
        </FacetGroup>
      )}

      <FacetGroup label="Receipt status" open={openGroups.receipt} onToggle={() => onToggleGroup('receipt')}>
        <div className="grid grid-cols-2 gap-1">
          {(['missing', 'pending', 'matched', 'n/a', 'waived'] as const).map((status) => (
            <button
              key={status}
              type="button"
              onClick={() => onReceiptToggle(status)}
              className={cn(
                'rounded-md px-2 py-1 text-xs font-bold transition-colors',
                receipts.includes(status) ? 'bg-inverse text-inverse-foreground' : 'bg-cream/40 text-ink hover:bg-cream',
              )}
            >
              {status}
            </button>
          ))}
        </div>

        <div className="mt-3 border-t border-ink2/10 pt-3">
          <div className="font-mono text-[10px] font-medium uppercase tracking-wider text-dim">Waive old receipts</div>
          <p className="mt-1 text-[11px] leading-snug text-dim">
            Mark spend before this date as not needing a receipt (e.g. history pulled before you started collecting receipts).
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Input
              type="date"
              value={waiveBefore}
              max={today()}
              onChange={(event) => onWaiveBeforeChange(event.target.value)}
              className="h-8 flex-1 text-xs"
            />
            <Button size="sm" variant="outline" disabled={waiving || !waiveBefore} onClick={onWaiveOld}>
              {waiving ? 'Waiving...' : 'Waive'}
            </Button>
          </div>
        </div>
      </FacetGroup>
    </aside>
  );
}
