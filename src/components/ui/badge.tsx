import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-bold transition-colors',
  {
    variants: {
      variant: {
        default: 'bg-inverse text-inverse-foreground',
        outline: 'border border-ink2/40 text-ink',
        secondary: 'bg-cream text-ink',
        muted: 'bg-ink/5 text-dim',
        success: 'bg-sage text-on-sage',
        warning: 'bg-lemon text-lemon-ink',
        danger: 'bg-pink text-pink-ink',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
