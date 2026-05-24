import { useEffect, useState } from 'react';
import { ChevronDown, Save } from 'lucide-react';
import type { AdminOverview } from '@/api';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { FieldText } from '../fields';

interface Props {
  rule: AdminOverview['rules'][number];
  categories: AdminOverview['categories'];
  onSave: (body: Partial<AdminOverview['rules'][number]>) => Promise<boolean>;
}

export function EditableRule({ rule, categories, onSave }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(rule);
  useEffect(() => setDraft(rule), [rule]);
  const categoryName = categories.find((c) => c.id === rule.categoryId)?.name ?? '—';

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border border-ink2/10 bg-[hsl(var(--color-sunken))]">
      <CollapsibleTrigger asChild>
        <button type="button" className="flex w-full items-center gap-3 px-4 py-3 text-left">
          <Badge variant="muted">{rule.matchKind}</Badge>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-mono text-sm text-ink">{rule.pattern || '(empty)'}</span>
            <span className="block truncate text-xs text-dim">→ {categoryName} · priority {rule.priority}</span>
          </span>
          <ChevronDown className={cn('h-4 w-4 text-dim transition-transform', open && 'rotate-180')} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid gap-3 border-t border-ink2/10 p-4 md:grid-cols-2">
          <FieldText label="Match kind" value={draft.matchKind} onChange={(matchKind) => setDraft({ ...draft, matchKind })} />
          <FieldText label="Pattern" value={draft.pattern} onChange={(pattern) => setDraft({ ...draft, pattern })} />
          <FieldText
            label="Priority"
            type="number"
            value={String(draft.priority)}
            onChange={(priority) => setDraft({ ...draft, priority: Number(priority) })}
          />
          <div className="flex items-end justify-end gap-2 md:col-span-2">
            <Button variant="outline" size="sm" onClick={() => { setDraft(rule); setOpen(false); }}>
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
