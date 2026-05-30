import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

const tileVariants = cva(
  'relative flex flex-col overflow-hidden rounded-xl border border-ink2/8 shadow-sm transition-shadow min-w-0',
  {
    variants: {
      tone: {
        paper: 'bg-paper text-ink',
        cream: 'bg-cream text-ink',
        lemon: 'bg-lemon text-lemon-ink',
        coral: 'bg-coral text-on-coral',
        sage: 'bg-sage text-on-sage',
        sky: 'bg-sky text-sky-ink',
        pink: 'bg-pink text-pink-ink',
        plum: 'bg-plum text-strong-foreground',
        purple: 'bg-purple text-purple-ink',
        ink: 'bg-strong text-strong-foreground',
        sunken: 'bg-[hsl(var(--color-sunken))] text-ink',
      },
      pad: {
        none: 'p-0',
        sm: 'p-4',
        md: 'p-5',
        lg: 'p-6',
      },
      interactive: {
        true: 'cursor-pointer hover:shadow-md',
        false: '',
      },
    },
    defaultVariants: {
      tone: 'paper',
      pad: 'md',
      interactive: false,
    },
  },
);

type Span = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

export interface TileProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof tileVariants> {
  colSpan?: Span;
  rowSpan?: 1 | 2 | 3 | 4;
}

// Static column-span class map so Tailwind picks them up during JIT scan.
const colSpanClass: Record<Span, string> = {
  1: 'col-span-1',
  2: 'col-span-2',
  3: 'col-span-3',
  4: 'col-span-4',
  5: 'col-span-5',
  6: 'col-span-6',
  7: 'col-span-7',
  8: 'col-span-8',
  9: 'col-span-9',
  10: 'col-span-10',
  11: 'col-span-11',
  12: 'col-span-12',
};

const rowSpanClass: Record<NonNullable<TileProps['rowSpan']>, string> = {
  1: 'row-span-1',
  2: 'row-span-2',
  3: 'row-span-3',
  4: 'row-span-4',
};

const Tile = React.forwardRef<HTMLDivElement, TileProps>(
  ({ className, tone, pad, interactive, colSpan, rowSpan, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        tileVariants({ tone, pad, interactive }),
        colSpan && colSpanClass[colSpan],
        rowSpan && rowSpanClass[rowSpan],
        className,
      )}
      {...props}
    />
  ),
);
Tile.displayName = 'Tile';

export { Tile, tileVariants };
