import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export function LogoMark({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      {...props}
      aria-hidden="true"
      className={cn('inline-flex shrink-0 overflow-hidden rounded-lg bg-strong shadow-sm ring-1 ring-ink2/10', className)}
    >
      <img src="/ledger-logo.png" alt="" draggable={false} className="h-full w-full object-cover" />
    </span>
  );
}
