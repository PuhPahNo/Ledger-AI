import * as React from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';

const VIEWPORT_MARGIN = 8;
const TOOLTIP_GAP = 12;

/**
 * Lightweight hover tooltip for SVG charts.
 * Use via {@link useChartTooltip} — the returned `tip` state drives this component.
 */
interface ChartTooltipProps {
  open: boolean;
  /** Viewport/client position from the pointer event. */
  x: number;
  y: number;
  children?: React.ReactNode;
}

export function ChartTooltip({ open, x, y, children }: ChartTooltipProps) {
  const tooltipRef = React.useRef<HTMLDivElement>(null);
  const [position, setPosition] = React.useState({
    left: x,
    top: y - TOOLTIP_GAP,
    placement: 'top' as 'top' | 'bottom',
  });

  React.useLayoutEffect(() => {
    if (!open || typeof window === 'undefined') return;
    const node = tooltipRef.current;
    if (!node) return;

    const rect = node.getBoundingClientRect();
    const minLeft = rect.width / 2 + VIEWPORT_MARGIN;
    const maxLeft = window.innerWidth - rect.width / 2 - VIEWPORT_MARGIN;
    const left = maxLeft >= minLeft
      ? Math.min(Math.max(x, minLeft), maxLeft)
      : window.innerWidth / 2;
    const fitsAbove = y - rect.height - TOOLTIP_GAP >= VIEWPORT_MARGIN;
    const top = fitsAbove
      ? y - TOOLTIP_GAP
      : Math.min(y + TOOLTIP_GAP, window.innerHeight - rect.height - VIEWPORT_MARGIN);
    const next = {
      left,
      top: Math.max(VIEWPORT_MARGIN, top),
      placement: fitsAbove ? 'top' as const : 'bottom' as const,
    };

    setPosition((current) => (
      current.left === next.left && current.top === next.top && current.placement === next.placement
        ? current
        : next
    ));
  }, [children, open, x, y]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={tooltipRef}
      role="tooltip"
      className={cn(
        'pointer-events-none fixed z-[1000] max-w-[min(18rem,calc(100vw-1rem))]',
        'whitespace-normal rounded-md bg-strong px-2.5 py-1.5 text-xs text-strong-foreground shadow-md',
        'animate-in fade-in-0 zoom-in-95',
      )}
      style={{
        left: position.left,
        top: position.top,
        transform: position.placement === 'top' ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
      }}
    >
      {children}
    </div>,
    document.body,
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
 *   - `containerRef` — attach to the wrapping div for mouse-leave handling
 *   - `show(data, event)` — call from onMouseEnter/onMouseMove on each chart element
 *   - `hide()` — call from onMouseLeave on the container
 */
export function useChartTooltip<T>() {
  const [tip, setTip] = React.useState<ChartTooltipState<T>>({ open: false, x: 0, y: 0, data: null });
  const containerRef = React.useRef<HTMLDivElement>(null);

  const show = React.useCallback((data: T, event: React.MouseEvent) => {
    setTip({
      open: true,
      x: event.clientX,
      y: event.clientY,
      data,
    });
  }, []);

  const hide = React.useCallback(() => {
    setTip((current) => (current.open ? { ...current, open: false } : current));
  }, []);

  return { tip, containerRef, show, hide };
}
