import * as React from 'react';
import { cn } from '@/lib/cn';

interface Props {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  eyebrow?: React.ReactNode;
  className?: string;
}

export function SectionHeader({ title, description, actions, eyebrow, className }: Props) {
  return (
    <header className={cn('flex flex-wrap items-center gap-4', className)}>
      <div className="min-w-0 flex-1">
        {eyebrow && (
          <div className="mb-1 font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">
            {eyebrow}
          </div>
        )}
        <h1 className="font-display text-2xl font-bold leading-tight tracking-tight text-ink sm:text-3xl">
          {title}
        </h1>
        {description && <p className="mt-1 text-sm text-dim">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}
