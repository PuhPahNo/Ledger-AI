import type { BusinessId, OwnerInsightsSummary, Transaction } from '@/types/domain';
import { isExcludedFromSpend, isSpendTransaction } from '@/lib/calc';
import { http, useMockApi } from './client';
import { mapTransaction, type ApiTransaction } from './mapper';
import { BUSINESSES, TRANSACTIONS, visibleMockTransactions } from './mocks';

export interface OwnerInsightsParams {
  from?: string;
  to?: string;
  biz?: BusinessId | 'all';
  accountIds?: string[];
}

interface ApiOwnerInsightsSummary extends Omit<OwnerInsightsSummary, 'topPurchases'> {
  topPurchases: ApiTransaction[];
}

export function getOwnerInsights(params: OwnerInsightsParams = {}): Promise<OwnerInsightsSummary> {
  if (useMockApi) return Promise.resolve(mockOwnerInsights(params));
  const query = new URLSearchParams();
  if (params.from) query.set('from', params.from);
  if (params.to) query.set('to', params.to);
  if (params.biz && params.biz !== 'all') query.set('biz', params.biz);
  if (params.accountIds?.length) query.set('accounts', params.accountIds.join(','));
  return http<ApiOwnerInsightsSummary>(`/owner-insights?${query.toString()}`).then((summary) => ({
    ...summary,
    topPurchases: summary.topPurchases.map(mapTransaction),
  }));
}

function mockOwnerInsights(params: OwnerInsightsParams): OwnerInsightsSummary {
  const to = params.to ?? today();
  const from = params.from ?? `${to.slice(0, 7)}-01`;
  const rows = visibleMockTransactions(TRANSACTIONS, params.accountIds)
    .filter((row) => !params.biz || params.biz === 'all' || row.biz === params.biz)
    .filter((row) => row.date >= from && row.date <= to);
  const spendRows = rows.filter(isSpendTransaction);
  const inflows = rows.filter((row) => row.amount > 0 && !isExcludedFromSpend(row));
  const transferRows = rows.filter(isExcludedFromSpend);
  const incomeByBusiness = BUSINESSES.map((business) => {
    const businessInflows = inflows.filter((row) => row.biz === business.id);
    return {
      businessId: business.id,
      businessName: business.name,
      color: business.color,
      cents: centsTotal(businessInflows),
      count: businessInflows.length,
    };
  }).filter((row) => row.cents > 0);
  const outflowCents = Math.abs(centsTotal(spendRows));
  const inflowCents = centsTotal(inflows);

  return {
    from,
    to,
    topPurchases: [...spendRows].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, 12),
    uncategorized: metric(spendRows.filter((row) => row.cat === 'Uncategorized')),
    missingReceipts: metric(spendRows.filter((row) => row.receipt === 'missing')),
    transfers: { count: transferRows.length, cents: Math.abs(centsTotal(transferRows)) },
    incomeByBusiness,
    closeSummary: {
      inflowCents,
      outflowCents,
      netCents: inflowCents - outflowCents,
      transactionCount: rows.length,
    },
  };
}

function metric(rows: Transaction[]) {
  return {
    count: rows.length,
    cents: Math.abs(centsTotal(rows)),
  };
}

function centsTotal(rows: Transaction[]): number {
  return rows.reduce((sum, row) => sum + Math.round(row.amount * 100), 0);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
