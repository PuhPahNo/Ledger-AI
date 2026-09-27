import type { ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';

export type NeedsYouTone = 'danger' | 'warning' | 'info';

/** One compact Needs-you line: icon, what's waiting, and the button that takes you to fix it. */
export function NeedsYouRow({
  icon,
  tone,
  title,
  detail,
  action,
  wrapDetail,
  children,
}: {
  icon: ReactNode;
  tone: NeedsYouTone;
  title: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
  /** Let the detail wrap to two lines instead of truncating (for sentences, not lists). */
  wrapDetail?: boolean;
  children?: ReactNode;
}) {
  return (
    <li className="px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
            tone === 'danger' && 'bg-coral/20 text-coral-ink',
            tone === 'warning' && 'bg-lemon/40 text-lemon-ink dark:bg-lemon/15 dark:text-lemon',
            tone === 'info' && 'bg-[hsl(var(--color-sunken))] text-dim',
          )}
          aria-hidden="true"
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1 basis-48">
          <div className="text-sm font-bold text-ink">{title}</div>
          {detail && <div className={cn('text-xs text-dim', wrapDetail ? 'line-clamp-2' : 'truncate')}>{detail}</div>}
        </div>
        {action && <div className="ml-auto flex shrink-0 flex-wrap items-center gap-1.5">{action}</div>}
      </div>
      {children}
    </li>
  );
}

export function GoButton({ label, onClick }: { label: string; onClick?: () => void }) {
  return (
    <Button variant="outline" size="sm" onClick={onClick}>
      {label}
      <ArrowRight className="h-3.5 w-3.5" />
    </Button>
  );
}
