import * as React from 'react';
import type { Business } from '@/types/domain';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

let idCounter = 0;
export function useFieldId() {
  const [id] = React.useState(() => `admin-${++idCounter}`);
  return id;
}

export function FieldText({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
}) {
  const id = useFieldId();
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
    </div>
  );
}

export function FieldSelect({
  label,
  value,
  onChange,
  options,
  placeholder = 'Choose',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
}) {
  const id = useFieldId();
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function FieldBusiness({
  label,
  value,
  businesses,
  onChange,
}: {
  label: string;
  value: string;
  businesses: Business[];
  onChange: (value: string) => void;
}) {
  const options = [
    { value: 'global', label: 'Global (no business)' },
    ...businesses.map((business) => ({
      value: business.dbId ?? business.id,
      label: business.name,
    })),
  ];
  return (
    <FieldSelect
      label={label}
      value={value || 'global'}
      onChange={(next) => onChange(next === 'global' ? '' : next)}
      options={options}
    />
  );
}

export function FieldColor({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useFieldId();
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-10 w-12 cursor-pointer rounded-md border border-ink2/30 bg-paper p-1"
        />
        <Input value={value} onChange={(event) => onChange(event.target.value)} className="font-mono" />
      </div>
    </div>
  );
}

export function FieldSwitch({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const id = useFieldId();
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-ink2/10 bg-paper px-3 py-2">
      <Label htmlFor={id} className="cursor-pointer">{label}</Label>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

export function ListRow({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-ink2/8 bg-[hsl(var(--color-sunken))] px-3 py-2 text-sm">
      <span className="min-w-0 flex-1 truncate font-medium text-ink">{left}</span>
      <span className="shrink-0 text-dim">{right}</span>
    </div>
  );
}

export type SaveAndRefresh = (work: () => Promise<unknown>, message: string) => Promise<boolean>;
