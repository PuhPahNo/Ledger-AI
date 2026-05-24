import * as React from 'react';
import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group';
import { cn } from '@/lib/cn';

const ToggleGroupContext = React.createContext<{ size?: 'sm' | 'default'; variant?: 'pill' | 'outline' }>({});

interface ToggleGroupProps {
  size?: 'sm' | 'default';
  variant?: 'pill' | 'outline';
}

const ToggleGroup = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root> & ToggleGroupProps
>(({ className, size, variant = 'pill', children, ...props }, ref) => (
  <ToggleGroupPrimitive.Root
    ref={ref}
    className={cn(
      'inline-flex items-center gap-1',
      variant === 'pill' && 'rounded-full bg-paper p-1 shadow-xs',
      className,
    )}
    {...props}
  >
    <ToggleGroupContext.Provider value={{ size, variant }}>{children}</ToggleGroupContext.Provider>
  </ToggleGroupPrimitive.Root>
));
ToggleGroup.displayName = ToggleGroupPrimitive.Root.displayName;

const ToggleGroupItem = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item>
>(({ className, children, ...props }, ref) => {
  const ctx = React.useContext(ToggleGroupContext);
  return (
    <ToggleGroupPrimitive.Item
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center whitespace-nowrap transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 focus-visible:ring-offset-2 focus-visible:ring-offset-paper',
        'disabled:pointer-events-none disabled:opacity-50',
        ctx.variant === 'pill'
          ? 'rounded-full px-3 py-1.5 text-xs font-bold text-dim hover:text-ink data-[state=on]:bg-ink data-[state=on]:text-lemon'
          : 'rounded-md border border-ink2/30 bg-transparent px-3 py-2 text-sm text-ink hover:bg-ink/5 data-[state=on]:bg-ink data-[state=on]:text-lemon',
        ctx.size === 'sm' && 'px-2 py-1 text-[11px]',
        className,
      )}
      {...props}
    >
      {children}
    </ToggleGroupPrimitive.Item>
  );
});
ToggleGroupItem.displayName = ToggleGroupPrimitive.Item.displayName;

export { ToggleGroup, ToggleGroupItem };
