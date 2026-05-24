import { AlertTriangle } from 'lucide-react';
import type { Alert } from '@/types/domain';
import { Tile } from '@/components/ui/tile';
import { Button } from '@/components/ui/button';
import { StatLabel } from '@/components/ui/stat-label';

interface Props {
  alerts: Alert[];
  onReview?: (alert: Alert) => void;
  onDismiss?: (alert: Alert) => void;
}

export function AlertsTile({ alerts, onReview, onDismiss }: Props) {
  const lead = alerts[0];

  return (
    <Tile tone="pink" pad="md" colSpan={4} rowSpan={1} className="gap-2">
      <div className="flex items-baseline gap-2">
        <StatLabel className="flex items-center gap-1 text-pink-ink/80">
          <AlertTriangle className="h-3 w-3" />
          FLAGS · {alerts.length}
        </StatLabel>
        {alerts.length > 1 && (
          <span className="ml-auto text-xs text-pink-ink/70">+{alerts.length - 1} more</span>
        )}
      </div>
      {lead ? (
        <>
          <div className="font-display text-lg font-bold leading-snug text-pink-ink">{lead.title}</div>
          <div className="line-clamp-2 text-xs text-pink-ink/80">{lead.detail}</div>
          <div className="mt-auto flex gap-2 pt-1">
            <Button
              size="sm"
              onClick={() => onReview?.(lead)}
              className="bg-pink-ink text-pink hover:bg-pink-ink/90"
            >
              Review
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onDismiss?.(lead)}
              className="border-pink-ink/50 text-pink-ink hover:bg-pink-ink/10"
            >
              Dismiss
            </Button>
          </div>
        </>
      ) : (
        <div className="text-sm text-pink-ink/80">All clear — no flagged transactions.</div>
      )}
    </Tile>
  );
}
