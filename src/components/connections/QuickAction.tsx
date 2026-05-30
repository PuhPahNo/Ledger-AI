import type { ReactNode } from 'react';

interface Props {
  icon: ReactNode;
  title: string;
  detail: string;
  disabled?: boolean;
  loading?: boolean;
  onClick: () => void;
}

export function QuickAction({ icon, title, detail, disabled = false, loading = false, onClick }: Props) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex items-center gap-3 rounded-lg border border-ink2/10 bg-[hsl(var(--color-sunken))] p-3 text-left transition-all hover:border-ink2/25 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-md bg-inverse text-inverse-foreground">{icon}</span>
      <span className="grid">
        <span className="font-bold text-ink">{title}</span>
        <span className="text-xs text-dim">{loading ? 'Working…' : detail}</span>
      </span>
    </button>
  );
}
