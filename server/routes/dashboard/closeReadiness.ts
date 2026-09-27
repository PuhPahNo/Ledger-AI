import { and, desc, eq, gte, isNull, like, lte, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { accounts, appSettings, businesses, categories, exportJobs, receipts, transactions } from '../../db/schema.js';
import { getSetting, setSetting } from '../../services/appSettings.js';
import { listCategorizationReviewItems } from '../../services/categorizationFeedback.js';
import {
  accountSpendFilter,
  categoryIsVisibleSpend,
  dateFromIso,
  isoDate,
  normalizeInsightMetric,
  resolveSelectedBusiness,
  transferCategoryFilter,
} from './helpers.js';
import { failedSyncCountForBusiness } from './connectionHealth.js';

export async function buildCloseReadiness(input: {
  from: string;
  to: string;
  biz?: string;
  accountIds: string[];
}) {
  const selectedBusiness = await resolveSelectedBusiness(input.biz);
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
      // Reviews are resolved in Home › Needs you (the old view name redirects there).
      actionView: 'dashboard',
      filters: {},
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
      : 'Queue an audit export after the blocking items are clear.',
    severity: 'ready',
    count: exportJob ? 1 : 0,
    cents: undefined,
    actionView: 'admin',
    filters: { tab: 'exports' },
  });

  // Sign-off is per business + calendar month, so it survives the "to = today" default
  // moving forward and is shared by every range inside that month.
  const closeMonth = closeMonthForRange(input.from, input.to);
  const signoff = closeMonth ? await readCloseSignoff(biz, closeMonth) : emptySignoff;
  const changedSinceSignOff = closeMonth && signoff.signedOffAt
    ? await countChangedSince(closeMonth, selectedBusiness?.id ?? null, signoff.signedOffAt)
    : 0;
  const blockers = items.filter((item) => item.severity === 'blocker' && item.count > 0);
  const canSignOff = Boolean(closeMonth) && blockers.length === 0 && !signoff.signedOff;
  if (canSignOff) {
    items.push({
      id: 'sign-off',
      label: `Sign off ${monthLabel(closeMonth!)}`,
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
    closeMonth,
    signedOff: signoff.signedOff,
    signedOffAt: signoff.signedOffAt,
    changedSinceSignOff,
    canSignOff,
    items,
  };
}

const emptySignoff = { signedOff: false, signedOffAt: null } as const;

/** Setting key for a month-close sign-off: `close_signoff:<biz|all>:<YYYY-MM>`. */
export function closeSignoffKey(biz: string, month: string): string {
  return `close_signoff:${biz}:${month}`;
}

/** The calendar month (YYYY-MM) a range belongs to, or null when it spans several months. */
export function closeMonthForRange(from: string, to: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
  return from.slice(0, 7) === to.slice(0, 7) ? from.slice(0, 7) : null;
}

export function closeMonthBounds(month: string): { from: string; to: string } {
  const start = dateFromIso(`${month}-01`);
  return { from: isoDate(start), to: isoDate(new Date(start.getFullYear(), start.getMonth() + 1, 0)) };
}

/**
 * Legacy keys were `close_signoff:<biz>:<from>:<to>`. Returns the month such a key belongs
 * to (only when the range sat inside one month), else null.
 */
export function legacyCloseSignoffMonth(key: string, biz: string): string | null {
  const prefix = `close_signoff:${biz}:`;
  if (!key.startsWith(prefix)) return null;
  const [from, to, extra] = key.slice(prefix.length).split(':');
  if (!from || !to || extra !== undefined) return null;
  return closeMonthForRange(from, to);
}

export function parseCloseSignoff(raw: string | null): { signedOff: boolean; signedOffAt: string | null } {
  if (!raw) return { signedOff: false, signedOffAt: null };
  try {
    const parsed = JSON.parse(raw) as { signedOffAt?: unknown };
    return { signedOff: true, signedOffAt: typeof parsed.signedOffAt === 'string' ? parsed.signedOffAt : null };
  } catch {
    return { signedOff: true, signedOffAt: null };
  }
}

export async function readCloseSignoff(biz: string, month: string): Promise<{ signedOff: boolean; signedOffAt: string | null }> {
  const current = await getSetting(closeSignoffKey(biz, month));
  if (current) return parseCloseSignoff(current);
  // Fall back to legacy range-keyed sign-offs inside this month, and migrate the newest one.
  const legacyRows = await db.select().from(appSettings)
    .where(like(appSettings.key, `close_signoff:${biz}:${month}-%`))
    .orderBy(desc(appSettings.updatedAt));
  const legacy = legacyRows.find((row) => legacyCloseSignoffMonth(row.key, biz) === month);
  if (!legacy) return { signedOff: false, signedOffAt: null };
  await setSetting(closeSignoffKey(biz, month), legacy.value);
  return parseCloseSignoff(legacy.value);
}

/** Transactions in the month that were created or edited after the sign-off timestamp. */
async function countChangedSince(month: string, businessId: string | null, signedOffAt: string): Promise<number> {
  const { from, to } = closeMonthBounds(month);
  const [row] = await db.select({ count: sql<number>`count(*)::int` })
    .from(transactions)
    .where(and(
      gte(transactions.date, from),
      lte(transactions.date, to),
      businessId ? eq(transactions.businessId, businessId) : sql`true`,
      sql`greatest(${transactions.createdAt}, ${transactions.updatedAt}) > ${signedOffAt}::timestamptz`,
    ));
  return Number(row?.count ?? 0);
}

function monthLabel(month: string): string {
  return dateFromIso(`${month}-01`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
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

function formatCentsForClose(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cents / 100);
}
