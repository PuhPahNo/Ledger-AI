import * as React from 'react';
import { cn } from '@/lib/cn';

const StatLabel = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(
  ({ className, ...props }, ref) => (
    <span
      ref={ref}
      className={cn('font-mono text-[10px] font-medium uppercase tracking-[0.16em] opacity-70', className)}
      {...props}
    />
  ),
);
StatLabel.displayName = 'StatLabel';

export { StatLabel };
