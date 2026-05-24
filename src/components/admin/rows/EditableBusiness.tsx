import { useEffect, useState } from 'react';
import { ChevronDown, Save } from 'lucide-react';
import type { AdminOverview } from '@/api';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { FieldColor, FieldSwitch, FieldText } from '../fields';

interface Props {
  business: AdminOverview['businesses'][number];
  onSave: (body: Partial<AdminOverview['businesses'][number]>) => Promise<boolean>;
}

export function EditableBusiness({ business, onSave }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(business);
  useEffect(() => setDraft(business), [business]);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border border-ink2/10 bg-[hsl(var(--color-sunken))]">
      <CollapsibleTrigger asChild>
        <button type="button" className="flex w-full items-center gap-3 px-4 py-3 text-left">
          <span className="h-6 w-1.5 rounded-full" style={{ background: business.color }} />
          <span className="min-w-0 flex-1">
            <span className="block font-bold text-ink">{business.name}</span>
            <span className="block truncate text-xs text-dim">{business.key} · {business.short}</span>
          </span>
          <Badge variant={business.active ? 'success' : 'muted'}>{business.active ? 'Active' : 'Disabled'}</Badge>
          <ChevronDown className={cn('h-4 w-4 text-dim transition-transform', open && 'rotate-180')} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid gap-3 border-t border-ink2/10 p-4 md:grid-cols-2">
          <FieldText label="Name" value={draft.name} onChange={(name) => setDraft({ ...draft, name })} />
          <FieldText label="Short code" value={draft.short} onChange={(short) => setDraft({ ...draft, short })} />
          <FieldText label="URL key" value={draft.key} onChange={(key) => setDraft({ ...draft, key })} />
          <FieldColor label="Color" value={draft.color} onChange={(color) => setDraft({ ...draft, color })} />
          <FieldSwitch label="Active" checked={draft.active} onCheckedChange={(active) => setDraft({ ...draft, active })} />
          <div className="flex items-end justify-end gap-2 md:col-span-2">
            <Button variant="outline" size="sm" onClick={() => { setDraft(business); setOpen(false); }}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => onSave(draft).then((ok) => ok && setOpen(false))}>
              <Save className="h-3.5 w-3.5" /> Save changes
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
