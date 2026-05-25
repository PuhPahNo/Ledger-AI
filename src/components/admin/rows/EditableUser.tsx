import { useEffect, useState } from 'react';
import { ChevronDown, Save } from 'lucide-react';
import type { AdminOverview } from '@/api';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { FieldSwitch, FieldText } from '../fields';

interface Props {
  admin: AdminOverview['users'][number];
  onSave: (body: { username?: string; displayName?: string }) => Promise<boolean>;
  onPassword: (password: string) => Promise<boolean | void>;
  onActive: (active: boolean) => Promise<boolean>;
}

export function EditableUser({ admin, onSave, onPassword, onActive }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(admin);
  const [password, setPassword] = useState('');
  useEffect(() => setDraft(admin), [admin]);

  const resetPassword = async () => {
    const ok = await onPassword(password);
    if (ok !== false) setPassword('');
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border border-ink2/10 bg-[hsl(var(--color-sunken))]">
      <CollapsibleTrigger asChild>
        <button type="button" className="flex w-full items-center gap-3 px-4 py-3 text-left">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-coral font-bold text-paper">
            {(admin.displayName || admin.username).slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-bold text-ink">{admin.displayName}</span>
            <span className="block truncate text-xs text-dim">{admin.username}</span>
          </span>
          {admin.totpEnabled && <Badge variant="muted">2FA</Badge>}
          <Badge variant={admin.active ? 'success' : 'muted'}>{admin.active ? 'Active' : 'Disabled'}</Badge>
          <ChevronDown className={cn('h-4 w-4 text-dim transition-transform', open && 'rotate-180')} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid gap-3 border-t border-ink2/10 p-4 md:grid-cols-2">
          <FieldText label="Username" value={draft.username} onChange={(username) => setDraft({ ...draft, username })} />
          <FieldText label="Display name" value={draft.displayName} onChange={(displayName) => setDraft({ ...draft, displayName })} />
          <FieldText
            label="New password"
            type="password"
            value={password}
            onChange={setPassword}
            placeholder="12+ characters"
            autoComplete="new-password"
            name={`admin-new-password-${admin.id}`}
          />
          <FieldSwitch
            label="Account active"
            checked={draft.active}
            onCheckedChange={(active) => {
              setDraft({ ...draft, active });
              void onActive(active);
            }}
          />
          <div className="flex items-end justify-end gap-2 md:col-span-2">
            <Button variant="outline" size="sm" onClick={resetPassword} disabled={!password}>
              Reset password
            </Button>
            <Button
              size="sm"
              onClick={() => onSave({ username: draft.username, displayName: draft.displayName }).then((ok) => ok && setOpen(false))}
            >
              <Save className="h-3.5 w-3.5" /> Save changes
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
