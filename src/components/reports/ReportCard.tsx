import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';

/** The titled card every report section sits in; a failed load replaces only its body. */
export function ReportCard({
  eyebrow,
  title,
  action,
  error,
  children,
}: {
  eyebrow: string;
  title: string;
  action?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <Card className="min-w-0 p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">{eyebrow}</div>
          <h2 className="font-display text-lg font-bold text-ink">{title}</h2>
        </div>
        {action}
      </div>
      {error ? (
        <div role="alert" className="rounded-lg border border-coral/30 bg-coral/10 p-3 text-sm font-bold text-coral-ink">Couldn't load: {error}</div>
      ) : children}
    </Card>
  );
}
