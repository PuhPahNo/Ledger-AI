import { Plus } from 'lucide-react';
import type { Connection } from '@/types/domain';
import { Tile } from '@/components/ui/tile';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface Props {
  connections: Connection[];
  onAdd?: () => void;
}

export function ConnectionsTile({ connections, onAdd }: Props) {
  return (
    <Tile tone="paper" pad="md" colSpan={4} rowSpan={1} className="gap-3">
      <div className="flex items-baseline gap-2">
        <div className="font-display text-base font-bold">Connections</div>
        <span className="text-xs text-dim">{connections.length} active</span>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onAdd}>
          <Plus className="h-3.5 w-3.5" />
          Add
        </Button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {connections.length ? connections.map((c, i) => <ConnectionChip key={c.id ?? i} connection={c} />) : (
          <div className="text-xs text-dim">No connections yet — click Add to get started.</div>
        )}
      </div>
    </Tile>
  );
}

function ConnectionChip({ connection: c }: { connection: Connection }) {
  const live = c.status === 'live';
  const label = c.kind === 'gmail' ? c.label.split('@')[0] : c.mask ?? c.label;
  const variant = live ? 'success' : c.status === 'reauth' ? 'warning' : 'muted';
  return (
    <Badge variant={variant} title={`${c.label} · ${c.status} · ${c.last}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" aria-hidden />
      {label}
    </Badge>
  );
}
