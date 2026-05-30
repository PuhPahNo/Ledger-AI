import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * Lightweight hover tooltip for SVG charts.
 * Use via {@link useChartTooltip} — the returned `tip` state drives this component.
 */
interface ChartTooltipProps {
  open: boolean;
  /** Position relative to the wrapping `.relative` container. */
  x: number;
  y: number;
  children?: React.ReactNode;
}

export function ChartTooltip({ open, x, y, children }: ChartTooltipProps) {
  if (!open) return null;
  return (
    <div
      role="tooltip"
      className={cn(
        'pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full',
        'whitespace-nowrap rounded-md bg-strong px-2.5 py-1.5 text-xs text-strong-foreground shadow-md',
        'animate-in fade-in-0 zoom-in-95',
      )}
      style={{ left: x, top: y - 10 }}
    >
      {children}
    </div>
  );
}

export interface ChartTooltipState<T = unknown> {
  open: boolean;
  x: number;
  y: number;
  data: T | null;
}

/**
 * Hook for binding hover tooltips to SVG chart elements.
 * Returns:
 *   - `tip` — the current tooltip state (drives `<ChartTooltip>`)
 *   - `containerRef` — attach to the wrapping `.relative` div
 *   - `show(data, event)` — call from onMouseEnter/onMouseMove on each chart element
 *   - `hide()` — call from onMouseLeave on the container
 */
export function useChartTooltip<T>() {
  const [tip, setTip] = React.useState<ChartTooltipState<T>>({ open: false, x: 0, y: 0, data: null });
  const containerRef = React.useRef<HTMLDivElement>(null);

  const show = React.useCallback((data: T, event: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTip({
      open: true,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      data,
    });
  }, []);

  const hide = React.useCallback(() => {
    setTip((current) => (current.open ? { ...current, open: false } : current));
  }, []);

  return { tip, containerRef, show, hide };
}
