import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

const moneyVariants = cva('font-display font-semibold tracking-tight tabular-nums leading-none', {
  variants: {
    size: {
      sm: 'text-lg',
      md: 'text-2xl',
      lg: 'text-4xl tracking-[-0.02em]',
      xl: 'text-5xl tracking-[-0.025em]',
      display: 'text-display tracking-[-0.03em]',
    },
  },
  defaultVariants: { size: 'md' },
});

export interface MoneyDisplayProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof moneyVariants> {}

const MoneyDisplay = React.forwardRef<HTMLDivElement, MoneyDisplayProps>(
  ({ className, size, ...props }, ref) => (
    <div ref={ref} className={cn(moneyVariants({ size }), className)} {...props} />
  ),
);
MoneyDisplay.displayName = 'MoneyDisplay';

export { MoneyDisplay };
