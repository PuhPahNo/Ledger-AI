import * as React from 'react';
import { cn } from '@/lib/cn';

const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'flex min-h-[80px] w-full rounded-md border border-ink2/30 bg-paper px-3 py-2 text-sm text-ink shadow-xs transition-colors',
        'placeholder:text-dim',
        'focus-visible:outline-none focus-visible:border-ink focus-visible:ring-2 focus-visible:ring-ink/15',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
);
Textarea.displayName = 'Textarea';

export { Textarea };
