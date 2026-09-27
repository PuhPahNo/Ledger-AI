// Pure formatting/ordering helpers for the match UI (no path aliases, so tests import them).
import type { Transaction } from '@/types/domain';
import type { MatchReason, MatchReasonStrength } from '@/types/receiptWorkflow';

const STRENGTH_ORDER: Record<MatchReasonStrength, number> = { conflict: 0, strong: 1, good: 2, weak: 3 };

/** Conflicts first (they're what a reviewer must see), then strongest to weakest. */
export function sortReasons(reasons: MatchReason[]): MatchReason[] {
  return [...reasons].sort((a, b) => STRENGTH_ORDER[a.strength] - STRENGTH_ORDER[b.strength]);
}

/** "Sep 10" style date for an ISO day. */
export function shortDate(isoDay?: string | null): string {
  if (!isoDay) return '—';
  const date = new Date(`${isoDay.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return isoDay;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "3h ago", "yesterday", "Sep 10". */
export function relativeTime(iso?: string | null, now = Date.now()): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const minutes = Math.round((now - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return shortDate(iso);
}

/** Closest amount first — the likeliest pair for a receipt with a known total. */
export function rankByAmount(rows: Transaction[], totalCents?: number | null): Transaction[] {
  if (totalCents == null) return rows;
  return [...rows].sort((a, b) => (
    Math.abs(Math.abs(a.amount) * 100 - totalCents) - Math.abs(Math.abs(b.amount) * 100 - totalCents)
  ));
}
