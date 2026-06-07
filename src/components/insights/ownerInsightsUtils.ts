import type { OwnerInsightsSummary } from '@/types/domain';

export function exportInsightsCsv(summary: OwnerInsightsSummary) {
  const rows = [
    ['section', 'date', 'merchant', 'business', 'category', 'amount'],
    ...summary.topPurchases.map((purchase) => [
      'top_purchase',
      purchase.date,
      purchase.merchant,
      purchase.biz,
      purchase.cat,
      String(Math.abs(Math.round(purchase.amount * 100))),
    ]),
    ['close_summary', summary.from, 'inflow', '', '', String(summary.closeSummary.inflowCents)],
    ['close_summary', summary.from, 'outflow', '', '', String(summary.closeSummary.outflowCents)],
    ['close_summary', summary.from, 'net', '', '', String(summary.closeSummary.netCents)],
    ['close_summary', summary.from, 'uncategorized', '', '', String(summary.uncategorized.cents)],
    ['close_summary', summary.from, 'missing_receipts', '', '', String(summary.missingReceipts.cents)],
    ['close_summary', summary.from, 'transfers', '', '', String(summary.transfers.cents)],
  ];
  const csv = rows.map((row) => row.map(csvCell).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `ledger-insights-${summary.from}-${summary.to}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function startOfMonth(): string {
  return `${new Date().toISOString().slice(0, 7)}-01`;
}

export function trailing12From(to: string): string {
  const date = new Date(`${to}T00:00:00`);
  date.setMonth(date.getMonth() - 11);
  date.setDate(1);
  return date.toISOString().slice(0, 10);
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
