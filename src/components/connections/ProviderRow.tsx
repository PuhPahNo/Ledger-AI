import { useEffect, useState } from 'react';
import { ChevronDown, CreditCard, Mail, Pencil, RefreshCcw, Trash2 } from 'lucide-react';
import type { Business, Connection } from '@/types/domain';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { BusinessSelect } from './BusinessSelect';
import { StatusBadge } from './StatusBadge';

interface Props {
  connection: Connection;
  businesses: Business[];
  onBusiness: (businessId: string) => void;
  onRename: (label: string) => void;
  onSync: () => void;
  onBackfill?: () => void;
  onBackfillDays?: (days: number) => void;
  backfillLabel?: string;
  backfillTooltip?: string;
  onDisconnect: () => void;
}

export function ProviderRow({
  connection,
  businesses,
  onBusiness,
  onRename,
  onSync,
  onBackfill,
  onBackfillDays,
  backfillLabel = '12m',
  backfillTooltip = 'Pull 12 months of Plaid history',
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
    <div className="grid gap-3 rounded-lg border border-ink2/10 bg-[hsl(var(--color-sunken))] p-3">
      <div className="flex items-center gap-3">
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
              className="h-8"
              placeholder="Connection name"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="group flex w-full items-center gap-1.5 truncate text-left font-bold text-ink hover:text-ink/80"
              title="Click to rename"
            >
              <span className="truncate">{connection.label}</span>
              <Pencil className="h-3 w-3 shrink-0 text-dim opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          )}
          <div className="truncate text-xs text-dim">{connection.last}</div>
        </div>
        <StatusBadge status={connection.status} />
      </div>

      {connection.health && (
        <div className="grid gap-2 rounded-md border border-ink2/10 bg-paper/60 p-2 text-[11px] sm:grid-cols-2">
          <HealthFact label="Last sync" value={formatHealthTime(connection.health.lastSyncAt)} />
          <HealthFact
            label={connection.kind === 'gmail' ? 'Last Pub/Sub' : 'Last webhook'}
            value={formatHealthTime(connection.kind === 'gmail' ? connection.health.lastPubSubAt : connection.health.lastWebhookAt)}
          />
          <HealthFact
            label="Queue"
            value={`${connection.health.queuedJobCount} active · ${connection.health.failedJobCount} failed`}
            tone={connection.health.failedJobCount > 0 ? 'bad' : connection.health.queuedJobCount > 0 ? 'warn' : 'default'}
          />
          <HealthFact
            label={connection.kind === 'gmail' ? 'Watch' : 'Last job'}
            value={connection.kind === 'gmail'
              ? connection.health.gmailWatchExpiration
                ? `${formatHealthTime(connection.health.gmailWatchExpiration)}${connection.health.gmailWatchRenewalDue ? ' · renew due' : ''}`
                : 'not active'
              : connection.health.lastJobStatus ?? 'none'}
            tone={connection.kind === 'gmail' && connection.health.gmailWatchRenewalDue ? 'warn' : 'default'}
          />
          {connection.health.lastJobError && (
            <div className="min-w-0 sm:col-span-2">
              <span className="font-bold uppercase tracking-wider text-coral-ink">Last error</span>
              <div className="truncate text-coral-ink" title={connection.health.lastJobError}>{connection.health.lastJobError}</div>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[180px] flex-1">
          <BusinessSelect value={connection.businessId ?? ''} businesses={businesses} onChange={onBusiness} />
        </div>
        {onBackfillDays && connection.health?.actions.gmailBackfillDays.length ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="px-2.5">
                Scan
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Gmail backfill</DropdownMenuLabel>
              {connection.health.actions.gmailBackfillDays.map((days) => (
                <DropdownMenuItem key={days} onSelect={() => onBackfillDays(days)}>
                  Last {days} days
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : onBackfill && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" onClick={onBackfill} className="px-2.5">
                {backfillLabel}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{backfillTooltip}</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="icon-sm" onClick={onSync} aria-label="Sync now">
              <RefreshCcw className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Sync now</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon-sm"
              onClick={onDisconnect}
              aria-label="Disconnect"
              className="text-coral-ink hover:bg-coral/10"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Disconnect</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

function HealthFact({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'warn' | 'bad';
}) {
  return (
    <div className="min-w-0">
      <span className="font-bold uppercase tracking-wider text-dim">{label}</span>
      <div className={tone === 'bad' ? 'truncate text-coral-ink' : tone === 'warn' ? 'truncate text-lemon-ink' : 'truncate text-ink'}>
        {value}
      </div>
    </div>
  );
}

function formatHealthTime(value?: string | null): string {
  if (!value) return 'never';
  const time = Date.parse(value);
  if (Number.isNaN(time)) return value;
  const deltaMs = Date.now() - time;
  const future = deltaMs < 0;
  const absMs = Math.abs(deltaMs);
  const minutes = Math.round(absMs / 60000);
  if (minutes < 1) return future ? 'in a minute' : 'just now';
  if (minutes < 60) return future ? `in ${minutes}m` : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return future ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return future ? `in ${days}d` : `${days}d ago`;
  return new Date(value).toLocaleDateString();
}
