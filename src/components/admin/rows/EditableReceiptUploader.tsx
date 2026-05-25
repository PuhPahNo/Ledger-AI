import { useEffect, useState } from 'react';
import { ChevronDown, Save, Trash2 } from 'lucide-react';
import type { AdminReceiptUploader } from '@/api';
import type { Business } from '@/types/domain';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { FieldBusiness, FieldSwitch, FieldText } from '../fields';

interface Props {
  uploader: AdminReceiptUploader;
  businesses: Business[];
  onSave: (body: { username?: string; displayName?: string; businessId?: string | null; active?: boolean }) => Promise<boolean>;
  onPassword: (password: string) => Promise<boolean | void>;
  onDelete: () => Promise<boolean>;
}

const receiptUploaderPasswordMinLength = 4;

export function EditableReceiptUploader({ uploader, businesses, onSave, onPassword, onDelete }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(uploader);
  const [password, setPassword] = useState('');
  useEffect(() => setDraft(uploader), [uploader]);

  const businessName = businesses.find((business) => business.dbId === uploader.businessId)?.name ?? 'Any business';
  const resetPassword = async () => {
    const ok = await onPassword(password);
    if (ok !== false) setPassword('');
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border border-ink2/10 bg-[hsl(var(--color-sunken))]">
      <CollapsibleTrigger asChild>
        <button type="button" className="flex w-full items-center gap-3 px-4 py-3 text-left">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-lemon font-bold text-lemon-ink">
            {(uploader.displayName || uploader.username).slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-bold text-ink">{uploader.displayName}</span>
            <span className="block truncate text-xs text-dim">{uploader.username} - {businessName}</span>
          </span>
          <Badge variant={uploader.active ? 'success' : 'muted'}>{uploader.active ? 'Active' : 'Disabled'}</Badge>
          <ChevronDown className={cn('h-4 w-4 text-dim transition-transform', open && 'rotate-180')} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid gap-3 border-t border-ink2/10 p-4 md:grid-cols-2">
          <FieldText label="Username" value={draft.username} onChange={(username) => setDraft({ ...draft, username })} />
          <FieldText label="Display name" value={draft.displayName} onChange={(displayName) => setDraft({ ...draft, displayName })} />
          <FieldBusiness
            label="Business"
            value={draft.businessId ?? ''}
            businesses={businesses}
            onChange={(businessId) => setDraft({ ...draft, businessId: businessId || null })}
          />
          <FieldSwitch
            label="Account active"
            checked={draft.active}
            onCheckedChange={(active) => setDraft({ ...draft, active })}
          />
          <FieldText
            label="New password"
            type="password"
            value={password}
            onChange={setPassword}
            placeholder={`${receiptUploaderPasswordMinLength}+ characters`}
            autoComplete="new-password"
            name={`uploader-new-password-${uploader.id}`}
          />
          <div className="flex items-end justify-end gap-2">
            <Button variant="outline" size="sm" onClick={resetPassword} disabled={!password}>
              Reset password
            </Button>
          </div>
          <div className="flex items-end justify-between gap-2 md:col-span-2">
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                if (window.confirm(`Delete ${uploader.displayName}?`)) void onDelete();
              }}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
            <Button
              size="sm"
              onClick={() =>
                onSave({
                  username: draft.username,
                  displayName: draft.displayName,
                  businessId: draft.businessId || null,
                  active: draft.active,
                }).then((ok) => ok && setOpen(false))
              }
            >
              <Save className="h-3.5 w-3.5" /> Save changes
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
