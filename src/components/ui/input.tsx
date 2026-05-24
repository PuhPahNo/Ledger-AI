import * as React from 'react';
import { cn } from '@/lib/cn';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, invalid, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        'flex h-10 w-full rounded-md border border-ink2/30 bg-paper px-3 py-2 text-sm text-ink shadow-xs transition-colors',
        'placeholder:text-dim',
        'focus-visible:outline-none focus-visible:border-ink focus-visible:ring-2 focus-visible:ring-ink/15',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-[invalid=true]:border-coral aria-[invalid=true]:focus-visible:ring-coral/25',
        'file:border-0 file:bg-transparent file:text-sm file:font-medium',
        className,
      )}
      {...props}
    />
  )
);
Input.displayName = 'Input';

export { Input };
