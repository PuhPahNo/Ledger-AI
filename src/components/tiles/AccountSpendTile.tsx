import { CreditCard, EyeOff, Landmark } from 'lucide-react';
import type { Account, Business, Transaction } from '@/types/domain';
import { fmt$k } from '@/lib/format';
import { accountLabel } from '@/lib/account';
import { isSpendTransaction } from '@/lib/calc';
import { Tile } from '@/components/ui/tile';
import { Button } from '@/components/ui/button';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { cn } from '@/lib/cn';

interface Props {
  accounts: Account[];
  businesses: Business[];
  transactions: Transaction[];
  selectedAccountIds: string[];
  onToggleAccount: (accountId: string) => void;
  onClearAccounts: () => void;
  onManageAccounts: () => void;
}

export function AccountSpendTile({
  accounts,
  businesses,
  transactions,
  selectedAccountIds,
  onToggleAccount,
  onClearAccounts,
  onManageAccounts,
}: Props) {
  const selected = new Set(selectedAccountIds);
  const spendByAccount = transactions.reduce<Record<string, { amount: number; count: number }>>((acc, txn) => {
    if (!txn.accountId || !isSpendTransaction(txn)) return acc;
    const row = acc[txn.accountId] ?? { amount: 0, count: 0 };
    row.amount += Math.abs(txn.amount);
    row.count += 1;
    acc[txn.accountId] = row;
    return acc;
  }, {});
  const watched = accounts.filter((account) => account.enabled).length;
  const ignored = accounts.length - watched;
  const sortedAccounts = [...accounts].sort((a, b) => {
    const selectedDelta = Number(selected.has(b.id)) - Number(selected.has(a.id));
    if (selectedDelta !== 0) return selectedDelta;
    const enabledDelta = Number(b.enabled) - Number(a.enabled);
    if (enabledDelta !== 0) return enabledDelta;
    return (spendByAccount[b.id]?.amount ?? 0) - (spendByAccount[a.id]?.amount ?? 0);
  });

  return (
    <Tile tone="paper" pad="md" colSpan={12} rowSpan={1} className="gap-3">
      <div className="flex items-baseline gap-3">
        <div className="font-display text-base font-bold">Spend By Account</div>
        <span className="text-xs text-dim">
          {selected.size ? `${selected.size} selected` : `${watched} watched${ignored ? ` · ${ignored} ignored` : ''}`}
        </span>
        <span className="flex-1" />
        {selected.size > 0 && (
          <Button variant="outline" size="sm" onClick={onClearAccounts}>
            All accounts
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onManageAccounts}>
          Manage
        </Button>
      </div>

      {sortedAccounts.length ? (
        <ScrollArea>
          <div className="flex gap-2 pb-2">
            {sortedAccounts.map((account) => {
              const spend = spendByAccount[account.id] ?? { amount: 0, count: 0 };
              const active = selected.has(account.id);
              const business = businesses.find((item) => item.id === account.biz || item.dbId === account.businessId);
              return (
                <button
                  key={account.id}
                  type="button"
                  disabled={!account.enabled}
                  onClick={() => onToggleAccount(account.id)}
                  title={account.enabled ? `Filter spend to ${accountLabel(account)}` : `${accountLabel(account)} is ignored in spend results`}
                  className={cn(
                    'flex w-60 shrink-0 items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-all',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30',
                    active
                      ? 'border-ink bg-lemon text-ink shadow-sm'
                      : 'border-ink2/15 bg-[hsl(var(--color-sunken))] text-ink hover:border-ink2/30',
                    !account.enabled && 'cursor-not-allowed opacity-60',
                  )}
                >
                  <span
                    className={cn(
                      'flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
                      active ? 'bg-inverse text-inverse-foreground' : 'bg-paper text-ink',
                    )}
                  >
                    {account.enabled ? (
                      account.kind === 'credit' ? <CreditCard className="h-4 w-4" /> : <Landmark className="h-4 w-4" />
                    ) : (
                      <EyeOff className="h-4 w-4" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-xs font-bold">{accountLabel(account)}</span>
                    <span className="block truncate text-[10px] text-dim">
                      {account.mask ?? account.kind} · {business?.short ?? 'Unassigned'} · {account.enabled ? `${spend.count} txns` : 'ignored'}
                    </span>
                  </span>
                  <span className="font-display text-sm font-bold tabular-nums">
                    {account.enabled ? (selected.size > 0 && !active ? 'View' : fmt$k(spend.amount)) : 'Ignored'}
                  </span>
                </button>
              );
            })}
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      ) : (
        <div className="py-2 text-sm text-dim">Connected Plaid accounts will appear here.</div>
      )}
    </Tile>
  );
}
