import { useEffect, useState } from 'react';
import { CreditCard, Landmark, Pencil } from 'lucide-react';
import type { Account, Business } from '@/types/domain';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { BusinessSelect } from './BusinessSelect';

interface Props {
  account: Account;
  businesses: Business[];
  onBusiness: (businessId: string, applyToExisting?: boolean) => void;
  onEnabled: (enabled: boolean) => void;
  onRename: (nickname: string | null) => void;
}

export function AccountRow({ account, businesses, onBusiness, onEnabled, onRename }: Props) {
  const displayName = account.nickname?.trim() || account.name;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(displayName);
  useEffect(() => setDraft(displayName), [displayName]);

  const saveName = () => {
    const next = draft.trim();
    if (next === displayName) {
      setEditing(false);
      return;
    }
    // Clearing the nickname (or matching the underlying Plaid name) resets it to null.
    onRename(next.length === 0 || next === account.name ? null : next);
    setEditing(false);
  };

  return (
    <div
      className={`grid gap-3 rounded-lg border border-ink2/10 bg-[hsl(var(--color-sunken))] p-3 ${
        account.enabled ? '' : 'opacity-60'
      }`}
    >
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-paper text-ink">
          {account.kind === 'credit' ? <CreditCard className="h-4 w-4" /> : <Landmark className="h-4 w-4" />}
        </span>
        <div className="min-w-0 flex-1">
          {editing ? (
            <Input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={saveName}
              onKeyDown={(event) => {
                if (event.key === 'Enter') saveName();
                if (event.key === 'Escape') {
                  setDraft(displayName);
                  setEditing(false);
                }
              }}
              autoFocus
              className="h-8"
              placeholder={account.name}
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="group flex w-full items-center gap-1.5 truncate text-left font-bold text-ink hover:text-ink/80"
              title="Click to rename"
            >
              <span className="truncate">{displayName}</span>
              <Pencil className="h-3 w-3 shrink-0 text-dim opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          )}
          <div className="truncate text-xs text-dim">
            {account.kind}
            {account.mask ? ` · ${account.mask}` : ''}
            {account.nickname ? ` · ${account.name}` : ''}
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs font-bold text-dim">
          <Switch checked={account.enabled} onCheckedChange={onEnabled} aria-label={account.enabled ? 'Watched' : 'Ignored'} />
          <span className="hidden sm:inline">{account.enabled ? 'Watched' : 'Ignored'}</span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[180px] flex-1">
          <BusinessSelect value={account.businessId ?? ''} businesses={businesses} onChange={(next) => onBusiness(next, true)} />
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              disabled={!account.businessId}
              onClick={() => onBusiness(account.businessId ?? '', true)}
            >
              Reassign existing
            </Button>
          </TooltipTrigger>
          <TooltipContent>Apply current business to past transactions</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
