import { useEffect, useState } from 'react';
import { CreditCard, Mail, Pencil, RefreshCcw, Trash2 } from 'lucide-react';
import type { Business, Connection } from '@/types/domain';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { BusinessSelect } from './BusinessSelect';
import { StatusBadge } from './StatusBadge';

interface Props {
  connection: Connection;
  businesses: Business[];
  onBusiness: (businessId: string) => void;
  onRename: (label: string) => void;
  onSync: () => void;
  onBackfill?: () => void;
  onDisconnect: () => void;
}

export function ProviderRow({
  connection,
  businesses,
  onBusiness,
  onRename,
  onSync,
  onBackfill,
  onDisconnect,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(connection.label);
  useEffect(() => setLabel(connection.label), [connection.label]);

  const saveLabel = () => {
    const next = label.trim();
    if (!next || next === connection.label) {
      setEditing(false);
      setLabel(connection.label);
      return;
    }
    onRename(next);
    setEditing(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-ink2/8 bg-[hsl(var(--color-sunken))] p-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-paper text-ink">
        {connection.kind === 'gmail' ? <Mail className="h-4 w-4" /> : <CreditCard className="h-4 w-4" />}
      </span>
      <div className="min-w-0 flex-1">
        {editing ? (
          <Input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            onBlur={saveLabel}
            onKeyDown={(event) => {
              if (event.key === 'Enter') saveLabel();
              if (event.key === 'Escape') {
                setLabel(connection.label);
                setEditing(false);
              }
            }}
            autoFocus
            className="h-7"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="flex w-full items-center gap-1.5 truncate text-left font-bold text-ink hover:text-ink/80"
          >
            <span className="truncate">{connection.label}</span>
            <Pencil className="h-3 w-3 shrink-0 text-dim" />
          </button>
        )}
        <div className="truncate text-xs text-dim">{connection.last}</div>
      </div>
      <StatusBadge status={connection.status} />
      <div className="w-44">
        <BusinessSelect value={connection.businessId ?? ''} businesses={businesses} onChange={onBusiness} />
      </div>
      <div className="flex gap-1">
        {onBackfill && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" onClick={onBackfill} className="px-2 text-xs">
                12m
              </Button>
            </TooltipTrigger>
            <TooltipContent>Pull 12 months of Plaid history</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="icon-sm" onClick={onSync}>
              <RefreshCcw className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Sync now</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="icon-sm" onClick={onDisconnect} className="text-coral-ink hover:bg-coral/10">
              <Trash2 className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Disconnect</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
