import type { ReactNode } from 'react';
import type { ReceiptInboxItem } from '@/types/domain';
import { Label } from '@/components/ui/label';

export function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <Label htmlFor={htmlFor} className="font-mono text-[10px] uppercase tracking-wider text-dim">{label}</Label>
      {children}
    </div>
  );
}

export function receiptLabel(receipt: ReceiptInboxItem): string {
  return receipt.merchant || receipt.fileName || `${receipt.source} receipt`;
}

/** Matching needs both a total and a date — without them this receipt is stuck. */
export function receiptNeedsDetails(receipt: ReceiptInboxItem): boolean {
  return receipt.totalCents == null || !receipt.receiptDate;
}

export function formatCentsInput(cents?: number | null): string {
  return cents == null ? '' : (cents / 100).toFixed(2);
}

export function parseDollarInput(value: string): number | null | undefined {
  const normalized = value.replace(/[$,\s]/g, '');
  if (!normalized) return null;
  if (!/^\d+(\.\d{0,2})?$/.test(normalized)) return undefined;
  return Math.round(Number(normalized) * 100);
}
