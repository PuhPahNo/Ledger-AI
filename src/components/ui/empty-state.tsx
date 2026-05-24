import * as React from 'react';
import { cn } from '@/lib/cn';

interface Props {
  title?: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({ title, description, icon, action, className }: Props) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-ink2/20 bg-[hsl(var(--color-sunken))] px-4 py-8 text-center',
        className,
      )}
    >
      {icon && <div className="text-dim">{icon}</div>}
      {title && <div className="font-display text-base font-bold text-ink">{title}</div>}
      {description && <div className="max-w-sm text-sm text-dim">{description}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
