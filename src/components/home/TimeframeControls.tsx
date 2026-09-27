import { ChevronLeft, ChevronRight } from 'lucide-react';
import { shiftMonthKey } from '@/lib/dates';
import type { TimePreset } from '@/lib/periods';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

/** Month picker + range presets for Home. The preset reaches back from the picked month. */
export function TimeframeControls({
  month,
  preset,
  label,
  onMonthChange,
  onPresetChange,
}: {
  month: string;
  preset: TimePreset;
  label: string;
  onMonthChange: (month: string) => void;
  onPresetChange: (preset: TimePreset) => void;
}) {
  const shiftMonth = (delta: number) => onMonthChange(shiftMonthKey(month, delta));
  return (
    <div className="flex flex-wrap items-center gap-2 sm:gap-3">
      <div className="flex items-center gap-1 rounded-full bg-paper p-1 shadow-xs">
        <Button variant="ghost" size="icon-sm" onClick={() => shiftMonth(-1)} title="Previous month" aria-label="Previous month">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Input
          type="month"
          value={month}
          aria-label="Month"
          onChange={(event) => event.target.value && onMonthChange(event.target.value)}
          className="h-10 w-[9.5rem] rounded-full border-transparent bg-transparent px-2 text-xs font-bold focus-visible:bg-cream sm:h-8"
        />
        <Button variant="ghost" size="icon-sm" onClick={() => shiftMonth(1)} title="Next month" aria-label="Next month">
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
      <ToggleGroup
        type="single"
        value={preset}
        aria-label="Range"
        onValueChange={(value) => value && onPresetChange(value as TimePreset)}
      >
        <ToggleGroupItem value="month">Month</ToggleGroupItem>
        <ToggleGroupItem value="last3">3m</ToggleGroupItem>
        <ToggleGroupItem value="last12">12m</ToggleGroupItem>
        <ToggleGroupItem value="ytd">YTD</ToggleGroupItem>
      </ToggleGroup>
      <span className="text-xs text-dim">{label}</span>
    </div>
  );
}
