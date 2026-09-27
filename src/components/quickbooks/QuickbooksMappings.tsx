import { useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { updateQuickbooksMappings } from '@/api/quickbooks';
import type { QboMappings, QboMappingsUpdate } from '@/types/quickbooks';
import { useToast } from '@/hooks/useToast';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const NONE = '__none';

/** "N of M mapped" across bank/card accounts and expense accounts. */
export function mappingProgress(mappings: Pick<QboMappings, 'bankAccounts' | 'expenseAccounts'>): { mapped: number; total: number } {
  const rows = [
    ...mappings.bankAccounts.map((row) => Boolean(row.ledgerAccountId)),
    ...mappings.expenseAccounts.map((row) => Boolean(row.categoryId)),
  ];
  return { mapped: rows.filter(Boolean).length, total: rows.length };
}

/**
 * QuickBooks ↔ Ledger mapping editor: bank/card accounts to Ledger accounts (links bank
 * transactions to the books) and expense accounts to categories (QuickBooks' category signal).
 * Collapsed by default; each change saves immediately and queues a relink.
 */
export function QuickbooksMappings({
  mappings,
  onChange,
}: {
  mappings: QboMappings;
  onChange: (next: QboMappings) => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const { mapped, total } = mappingProgress(mappings);
  const pendingSuggestions = mappings.expenseAccounts.filter((row) => !row.categoryId && row.method == null && row.suggestion);

  const save = async (update: QboMappingsUpdate) => {
    setSaving(true);
    try {
      const result = await updateQuickbooksMappings(mappings.connectionId, update);
      onChange(result.mappings);
      toast({ variant: 'success', title: 'Mapping saved', description: result.relinkQueued ? 'Re-linking transactions in the background.' : undefined });
    } catch (error) {
      toast({ variant: 'destructive', title: 'Save failed', description: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setSaving(false);
    }
  };

  const ledgerAccountLabel = (id: string) => {
    const account = mappings.ledgerAccounts.find((row) => row.id === id);
    return account ? `${account.name}${account.mask ? ` ••${account.mask}` : ''}` : 'Unknown account';
  };

  return (
    <div className="rounded-lg border border-ink2/10">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left text-xs font-bold text-ink hover:bg-ink/5"
      >
        <span>Mappings</span>
        <span className={cn('font-normal', mapped < total ? 'text-lemon-ink dark:text-lemon' : 'text-dim')}>
          {mapped} of {total} mapped
        </span>
        {open ? <ChevronUp className="ml-auto h-4 w-4 text-dim" /> : <ChevronDown className="ml-auto h-4 w-4 text-dim" />}
      </button>
      {open && (
        <div className="grid gap-4 border-t border-ink2/10 p-3">
          <MappingSection
            title="Bank & card accounts"
            hint="Transactions on a mapped account are linked to their QuickBooks records."
          >
            {mappings.bankAccounts.length === 0 && <EmptyLine>No bank or card accounts in QuickBooks.</EmptyLine>}
            {mappings.bankAccounts.map((row) => {
              const suggested = new Set(row.suggestions.map((suggestion) => suggestion.ledgerAccountId));
              const ordered = [...mappings.ledgerAccounts].sort((a, b) => Number(suggested.has(b.id)) - Number(suggested.has(a.id)));
              return (
                <MappingRow
                  key={row.qboAccount.id}
                  name={`${row.qboAccount.name}${row.qboAccount.acctNumLast4 && !row.qboAccount.name.includes(row.qboAccount.acctNumLast4) ? ` ••${row.qboAccount.acctNumLast4}` : ''}`}
                  meta={row.qboAccount.accountType}
                  auto={row.method === 'auto'}
                >
                  <Select
                    value={row.ledgerAccountId ?? NONE}
                    disabled={saving}
                    onValueChange={(value) => void save({ bankAccounts: [{ qboAccountId: row.qboAccount.id, ledgerAccountId: value === NONE ? null : value }] })}
                  >
                    <SelectTrigger className="h-10 w-full text-xs sm:h-8 sm:w-56" aria-label={`Ledger account for ${row.qboAccount.name}`}>
                      <SelectValue>{row.ledgerAccountId ? ledgerAccountLabel(row.ledgerAccountId) : 'Not mapped'}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Not mapped</SelectItem>
                      {ordered.map((account) => (
                        <SelectItem key={account.id} value={account.id}>
                          {account.name}{account.mask ? ` ••${account.mask}` : ''}{suggested.has(account.id) ? ' · suggested' : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </MappingRow>
              );
            })}
          </MappingSection>

          <MappingSection
            title="Expense accounts → categories"
            hint="How a QuickBooks expense account suggests a Ledger category."
            action={pendingSuggestions.length > 0 ? (
              <Button
                variant="outline"
                size="sm"
                disabled={saving}
                onClick={() => void save({
                  expenseAccounts: pendingSuggestions.map((row) => ({ qboAccountId: row.qboAccount.id, categoryId: row.suggestion!.categoryId })),
                })}
              >
                Use {pendingSuggestions.length} suggestion{pendingSuggestions.length === 1 ? '' : 's'}
              </Button>
            ) : undefined}
          >
            {mappings.expenseAccounts.length === 0 && <EmptyLine>No expense accounts in QuickBooks.</EmptyLine>}
            {mappings.expenseAccounts.map((row) => (
              <MappingRow
                key={row.qboAccount.id}
                name={row.qboAccount.fullyQualifiedName ?? row.qboAccount.name}
                meta={row.contractLabor ? 'Contract labor' : null}
                auto={row.method === 'auto'}
              >
                <Select
                  value={row.categoryId ?? NONE}
                  disabled={saving}
                  onValueChange={(value) => void save({ expenseAccounts: [{ qboAccountId: row.qboAccount.id, categoryId: value === NONE ? null : value }] })}
                >
                  <SelectTrigger className="h-10 w-full text-xs sm:h-8 sm:w-56" aria-label={`Category for ${row.qboAccount.name}`}>
                    <SelectValue>
                      {row.categoryId
                        ? row.categoryName ?? mappings.categories.find((category) => category.id === row.categoryId)?.name ?? 'Unknown category'
                        : row.suggestion && row.method == null ? `Not mapped · try ${row.suggestion.name}` : 'Not mapped'}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Not mapped</SelectItem>
                    {row.suggestion && (
                      <SelectItem value={row.suggestion.categoryId}>{row.suggestion.name} · suggested</SelectItem>
                    )}
                    {mappings.categories
                      .filter((category) => category.id !== row.suggestion?.categoryId)
                      .map((category) => <SelectItem key={category.id} value={category.id}>{category.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </MappingRow>
            ))}
          </MappingSection>
        </div>
      )}
    </div>
  );
}

function MappingSection({ title, hint, action, children }: { title: string; hint: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-1.5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-xs font-bold uppercase tracking-wider text-dim">{title}</h4>
          <p className="text-xs text-dim">{hint}</p>
        </div>
        {action}
      </div>
      <ul className="divide-y divide-ink2/10">{children}</ul>
    </section>
  );
}

function MappingRow({ name, meta, auto, children }: { name: string; meta?: string | null; auto: boolean; children: ReactNode }) {
  return (
    <li className="flex flex-col gap-1.5 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="truncate text-sm text-ink">{name}</span>
        {meta && <span className="text-[11px] text-dim">{meta}</span>}
        {auto && <Badge variant="muted" className="px-1.5 py-0 text-[10px]">auto</Badge>}
      </div>
      <div className="shrink-0">{children}</div>
    </li>
  );
}

function EmptyLine({ children }: { children: ReactNode }) {
  return <li className="py-2 text-xs text-dim">{children}</li>;
}
