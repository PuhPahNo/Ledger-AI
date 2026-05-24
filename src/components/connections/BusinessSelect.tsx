import type { Business } from '@/types/domain';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface Props {
  id?: string;
  value: string;
  businesses: Business[];
  onChange: (value: string) => void;
  includeAll?: boolean;
}

export function BusinessSelect({ id, value, businesses, onChange, includeAll = true }: Props) {
  return (
    <Select
      value={value || (includeAll ? '__unassigned__' : '')}
      onValueChange={(next) => onChange(next === '__unassigned__' ? '' : next)}
    >
      <SelectTrigger id={id} className="h-9">
        <SelectValue placeholder={includeAll ? 'Unassigned' : 'Choose'} />
      </SelectTrigger>
      <SelectContent>
        {includeAll && <SelectItem value="__unassigned__">Unassigned</SelectItem>}
        {businesses.map((business) => (
          <SelectItem key={business.dbId ?? business.id} value={business.dbId ?? business.id}>
            {business.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
