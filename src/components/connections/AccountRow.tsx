import { CreditCard, Mail } from 'lucide-react';
import type { Account, Business } from '@/types/domain';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { BusinessSelect } from './BusinessSelect';

interface Props {
  account: Account;
  businesses: Business[];
  onBusiness: (businessId: string, applyToExisting?: boolean) => void;
  onEnabled: (enabled: boolean) => void;
}

export function AccountRow({ account, businesses, onBusiness, onEnabled }: Props) {
  return (
    <div className={`flex flex-wrap items-center gap-3 rounded-lg border border-ink2/8 bg-[hsl(var(--color-sunken))] p-3 ${account.enabled ? '' : 'opacity-60'}`}>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-paper text-ink">
        {account.kind === 'credit' ? <CreditCard className="h-4 w-4" /> : <Mail className="h-4 w-4" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-bold text-ink">{account.name}</div>
        <div className="truncate text-xs text-dim">
          {account.kind}
          {account.mask ? ` · ${account.mask}` : ''} · {account.enabled ? 'included in spend' : 'ignored'}
        </div>
      </div>
      <div className="w-44">
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
      <div className="flex items-center gap-2 text-xs font-bold text-dim">
        <Switch checked={account.enabled} onCheckedChange={onEnabled} />
        {account.enabled ? 'Watched' : 'Ignored'}
      </div>
    </div>
  );
}
