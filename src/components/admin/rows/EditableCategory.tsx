import { useEffect, useState } from 'react';
import { ChevronDown, Save } from 'lucide-react';
import type { AdminOverview } from '@/api';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { FieldColor, FieldSwitch, FieldText } from '../fields';

interface Props {
  category: AdminOverview['categories'][number];
  onSave: (body: Partial<AdminOverview['categories'][number]>) => Promise<boolean>;
}

export function EditableCategory({ category, onSave }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(category);
  useEffect(() => setDraft(category), [category]);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border border-ink2/10 bg-[hsl(var(--color-sunken))]">
      <CollapsibleTrigger asChild>
        <button type="button" className="flex w-full items-center gap-3 px-4 py-3 text-left">
          <span className="h-4 w-4 rounded-sm" style={{ background: category.color ?? '#D97757' }} />
          <span className="min-w-0 flex-1">
            <span className="block font-bold text-ink">{category.name}</span>
            <span className="block truncate text-xs text-dim">{category.taxCode || 'No tax code'}</span>
          </span>
          <Badge variant={category.active ? 'success' : 'muted'}>{category.active ? 'Active' : 'Disabled'}</Badge>
          <ChevronDown className={cn('h-4 w-4 text-dim transition-transform', open && 'rotate-180')} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid gap-3 border-t border-ink2/10 p-4 md:grid-cols-2">
          <FieldText label="Name" value={draft.name} onChange={(name) => setDraft({ ...draft, name })} />
          <FieldText label="Tax code" value={draft.taxCode ?? ''} onChange={(taxCode) => setDraft({ ...draft, taxCode })} />
          <FieldColor label="Color" value={draft.color ?? '#D97757'} onChange={(color) => setDraft({ ...draft, color })} />
          <FieldSwitch label="Active" checked={draft.active} onCheckedChange={(active) => setDraft({ ...draft, active })} />
          <div className="flex items-end justify-end gap-2 md:col-span-2">
            <Button variant="outline" size="sm" onClick={() => { setDraft(category); setOpen(false); }}>
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
