import { and, desc, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { accounts, businesses, categories, exportJobs, receipts, transactions } from '../../db/schema.js';
import { getSetting } from '../../services/appSettings.js';
import { listCategorizationReviewItems } from '../../services/categorizationFeedback.js';
import { accountSpendFilter, categoryIsVisibleSpend, normalizeInsightMetric, transferCategoryFilter } from './helpers.js';
import { failedSyncCountForBusiness } from './connectionHealth.js';

export async function buildCloseReadiness(input: {
  from: string;
  to: string;
  biz?: string;
  accountIds: string[];
}) {
  const selectedBusiness = input.biz && input.biz !== 'all'
    ? await db.query.businesses.findFirst({ where: eq(businesses.key, input.biz) })
    : null;
  const biz = selectedBusiness?.key ?? 'all';
  const baseTransactionFilters = [
    gte(transactions.date, input.from),
    lte(transactions.date, input.to),
    selectedBusiness ? eq(transactions.businessId, selectedBusiness.id) : sql`true`,
    accountSpendFilter(input.accountIds),
  ] as const;
  const [missingReceipts, uncategorized, transfers, unmatchedReceipts, reviewItems, exportRows] = await Promise.all([
    db.select({
      count: sql<number>`count(${transactions.id})::int`,
      cents: sql<number>`coalesce(abs(sum(${transactions.amountCents})), 0)::int`,
    }).from(transactions)
      .leftJoin(categories, eq(transactions.categoryId, categories.id))
      .leftJoin(accounts, eq(transactions.accountId, accounts.id))
      .where(and(...baseTransactionFilters, sql`${transactions.amountCents} < 0`, categoryIsVisibleSpend(), eq(transactions.receiptStatus, 'missing'))),
    db.select({
      count: sql<number>`count(${transactions.id})::int`,
      cents: sql<number>`coalesce(abs(sum(${transactions.amountCents})), 0)::int`,
    }).from(transactions)
      .leftJoin(categories, eq(transactions.categoryId, categories.id))
      .leftJoin(accounts, eq(transactions.accountId, accounts.id))
      .where(and(...baseTransactionFilters, sql`${transactions.amountCents} < 0`, categoryIsVisibleSpend(), or(sql`${categories.id} IS NULL`, eq(categories.name, 'Uncategorized')))),
    db.select({
      count: sql<number>`count(${transactions.id})::int`,
      cents: sql<number>`coalesce(sum(abs(${transactions.amountCents})), 0)::int`,
    }).from(transactions)
      .leftJoin(categories, eq(transactions.categoryId, categories.id))
      .leftJoin(accounts, eq(transactions.accountId, accounts.id))
      .where(and(...baseTransactionFilters, transferCategoryFilter())),
    db.select({
      count: sql<number>`count(${receipts.id})::int`,
    }).from(receipts)
      .leftJoin(businesses, eq(receipts.businessId, businesses.id))
      .where(and(
        selectedBusiness ? eq(receipts.businessId, selectedBusiness.id) : sql`true`,
        eq(receipts.status, 'pending'),
        isNull(receipts.transactionId),
        or(
          isNull(receipts.receiptDate),
          and(gte(receipts.receiptDate, input.from), lte(receipts.receiptDate, input.to)),
        )!,
      )),
    listCategorizationReviewItems({ status: 'open', businessKey: input.biz }),
    db.select().from(exportJobs).where(and(
      eq(exportJobs.dateFrom, input.from),
      eq(exportJobs.dateTo, input.to),
      selectedBusiness ? eq(exportJobs.businessId, selectedBusiness.id) : sql`${exportJobs.businessId} IS NULL`,
    )).orderBy(desc(exportJobs.createdAt)).limit(1),
  ]);

  const failedSyncCount = await failedSyncCountForBusiness(selectedBusiness?.id ?? null);
  const items = [
    closeItem({
      id: 'missing-receipts',
      label: `${normalizeInsightMetric(missingReceipts[0]).count} missing receipt${normalizeInsightMetric(missingReceipts[0]).count === 1 ? '' : 's'}`,
      detail: `${formatCentsForClose(normalizeInsightMetric(missingReceipts[0]).cents)} of operating outflow still needs documentation.`,
      severity: 'blocker',
      metric: normalizeInsightMetric(missingReceipts[0]),
      actionView: 'transactions',
      filters: { from: input.from, to: input.to, receipts: ['missing'], direction: 'operating-outflow', biz },
    }),
    closeItem({
      id: 'unmatched-receipts',
      label: `${Number(unmatchedReceipts[0]?.count ?? 0)} unmatched receipt${Number(unmatchedReceipts[0]?.count ?? 0) === 1 ? '' : 's'}`,
      detail: 'Receipts are waiting for transaction pairing or dismissal.',
      severity: 'blocker',
      count: Number(unmatchedReceipts[0]?.count ?? 0),
      actionView: 'receipts',
      filters: { source: 'all', biz },
    }),
    closeItem({
      id: 'uncategorized',
      label: `${normalizeInsightMetric(uncategorized[0]).count} uncategorized transaction${normalizeInsightMetric(uncategorized[0]).count === 1 ? '' : 's'}`,
      detail: `${formatCentsForClose(normalizeInsightMetric(uncategorized[0]).cents)} needs category review.`,
      severity: 'blocker',
      metric: normalizeInsightMetric(uncategorized[0]),
      actionView: 'transactions',
      filters: { from: input.from, to: input.to, categories: ['Uncategorized'], direction: 'operating-outflow', biz },
    }),
    closeItem({
      id: 'sync-failures',
      label: `${failedSyncCount} failed sync${failedSyncCount === 1 ? '' : 's'}`,
      detail: 'Resolve failed provider jobs or reauth prompts before signing off.',
      severity: 'blocker',
      count: failedSyncCount,
      actionView: 'admin',
      filters: { tab: 'connections' },
    }),
    closeItem({
      id: 'category-reviews',
      label: `${reviewItems.length} rule/category review${reviewItems.length === 1 ? '' : 's'}`,
      detail: 'Open suggestions should be accepted or dismissed before close.',
      severity: 'blocker',
      count: reviewItems.length,
      actionView: 'admin',
      filters: { tab: 'rules' },
    }),
    closeItem({
      id: 'transfers',
      label: `${normalizeInsightMetric(transfers[0]).count} transfer${normalizeInsightMetric(transfers[0]).count === 1 ? '' : 's'} to audit`,
      detail: `${formatCentsForClose(normalizeInsightMetric(transfers[0]).cents)} of transfer movement is visible for review.`,
      severity: 'review',
      metric: normalizeInsightMetric(transfers[0]),
      actionView: 'transactions',
      filters: { from: input.from, to: input.to, direction: 'transfer', biz },
    }),
  ].filter((item): item is NonNullable<typeof item> => Boolean(item));

  const exportJob = exportRows[0];
  items.push({
    id: 'export',
    label: exportJob ? `Export ${exportJob.status}` : 'Queue audit export',
    detail: exportJob
      ? 'An audit export exists for this period.'
      : 'Queue an audit export from Admin after the blocking items are clear.',
    severity: 'ready',
    count: exportJob ? 1 : 0,
    cents: undefined,
    actionView: 'admin',
    filters: { tab: 'exports' },
  });

  const signoff = await readCloseSignoff(biz, input.from, input.to);
  const blockers = items.filter((item) => item.severity === 'blocker' && item.count > 0);
  const canSignOff = blockers.length === 0 && !signoff.signedOff;
  if (canSignOff) {
    items.push({
      id: 'sign-off',
      label: 'Sign off period close',
      detail: 'All blocking close items are clear.',
      severity: 'ready',
      count: 1,
      cents: undefined,
      actionView: 'insights',
      filters: { from: input.from, to: input.to, biz },
    });
  }
  return {
    from: input.from,
    to: input.to,
    biz,
    signedOff: signoff.signedOff,
    signedOffAt: signoff.signedOffAt,
    canSignOff,
    items,
  };
}

export function closeSignoffKey(biz: string, from: string, to: string): string {
  return `close_signoff:${biz}:${from}:${to}`;
}

function closeItem(input: {
  id: string;
  label: string;
  detail: string;
  severity: 'blocker' | 'review' | 'ready';
  metric?: { count: number; cents: number };
  count?: number;
  actionView: 'dashboard' | 'transactions' | 'receipts' | 'cash-flow' | 'balances' | 'insights' | 'assistant' | 'admin';
  filters?: Record<string, string | string[] | boolean | null>;
}) {
  const count = input.metric?.count ?? input.count ?? 0;
  if (count <= 0 && input.severity !== 'ready') return null;
  return {
    id: input.id,
    label: input.label,
    detail: input.detail,
    severity: input.severity,
    count,
    cents: input.metric?.cents,
    actionView: input.actionView,
    filters: input.filters,
  };
}

async function readCloseSignoff(biz: string, from: string, to: string): Promise<{ signedOff: boolean; signedOffAt: string | null }> {
  const raw = await getSetting(closeSignoffKey(biz, from, to));
  if (!raw) return { signedOff: false, signedOffAt: null };
  try {
    const parsed = JSON.parse(raw) as { signedOffAt?: unknown };
    return { signedOff: true, signedOffAt: typeof parsed.signedOffAt === 'string' ? parsed.signedOffAt : null };
  } catch {
    return { signedOff: true, signedOffAt: null };
  }
}

function formatCentsForClose(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cents / 100);
}
