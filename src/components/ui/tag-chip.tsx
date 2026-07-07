import { X } from 'lucide-react';
import { cn } from '@/lib/cn';

/** Compact pill for a custom tag — colored dot + name, optional remove button. */
export function TagChip({
  name,
  color,
  onRemove,
  title,
  className,
}: {
  name: string;
  color: string;
  onRemove?: () => void;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border border-ink2/10 bg-cream/70 px-1.5 py-0.5 text-[10px] font-bold leading-none text-ink',
        className,
      )}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
      {name}
      {onRemove && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          className="-mr-0.5 rounded-full text-dim hover:text-ink"
          aria-label={`Remove ${name} tag`}
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </span>
  );
}
