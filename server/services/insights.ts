import { and, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { alerts, businesses } from '../db/schema.js';

type AlertKind = typeof alerts.$inferInsert['kind'];
type AlertSeverity = typeof alerts.$inferInsert['severity'];

export interface AlertCandidate {
  /** Stable identity: the same finding always yields the same key across runs. */
  dedupeKey: string;
  businessId: string | null;
  kind: AlertKind;
  severity: AlertSeverity;
  title: string;
  detail: string;
  payload: Record<string, unknown>;
}

export interface ExistingAlert {
  id: string;
  status: 'open' | 'dismissed';
  dedupeKey: string | null;
}

export interface AlertSyncPlan {
  inserts: AlertCandidate[];
  updates: Array<{ id: string; candidate: AlertCandidate }>;
  deleteIds: string[];
}

/**
 * Only anomaly alerts are generated here. Missing receipts and unmatched receipts are
 * already listed (with live counts) in the Inbox, so alerting on them again would show the
 * same thing twice.
 */
export const GENERATED_ALERT_KINDS: readonly AlertKind[] = ['dup', 'spike'];

/**
 * Reconcile freshly computed findings with stored alerts:
 * - open alert still found → refreshed in place (same id);
 * - dismissed alert still found → left dismissed (never resurrected);
 * - new finding → inserted;
 * - open alert no longer found, or a legacy open row without a key → deleted.
 */
export function planAlertSync(candidates: AlertCandidate[], existing: ExistingAlert[]): AlertSyncPlan {
  const byKey = new Map<string, ExistingAlert>();
  for (const row of existing) {
    if (!row.dedupeKey) continue;
    const current = byKey.get(row.dedupeKey);
    // A dismissal wins over any duplicate open row with the same key.
    if (!current || (row.status === 'dismissed' && current.status !== 'dismissed')) byKey.set(row.dedupeKey, row);
  }
  const plan: AlertSyncPlan = { inserts: [], updates: [], deleteIds: [] };
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.dedupeKey)) continue;
    seen.add(candidate.dedupeKey);
    const match = byKey.get(candidate.dedupeKey);
    if (!match) plan.inserts.push(candidate);
    else if (match.status === 'open') plan.updates.push({ id: match.id, candidate });
  }
  const kept = new Set(plan.updates.map((update) => update.id));
  for (const row of existing) {
    if (row.status !== 'open' || kept.has(row.id)) continue;
    plan.deleteIds.push(row.id);
  }
  return plan;
}

export async function regenerateInsights(): Promise<void> {
  const candidates = [
    ...(await findDuplicateSubscriptions()),
    ...(await findSpendSpikes()),
  ];
  await db.transaction(async (tx) => {
    // Serialize concurrent runs (worker retries, manual triggers).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('ledger_regenerate_insights'))`);
    // Dismissed alerts otherwise accumulate forever. Keep dismissals of non-dated findings
    // (duplicate subscriptions) so they stay dismissed; month-scoped spikes can age out.
    await tx.delete(alerts).where(and(
      eq(alerts.status, 'dismissed'),
      lt(alerts.dismissedAt, sql`now() - interval '90 days'`),
      or(eq(alerts.kind, 'spike'), sql`NOT (${alerts.payload} ? 'dedupeKey')`),
    ));
    const existingRows = await tx.select({
      id: alerts.id,
      status: alerts.status,
      dedupeKey: sql<string | null>`${alerts.payload}->>'dedupeKey'`,
    }).from(alerts);
    const plan = planAlertSync(candidates, existingRows);
    if (plan.deleteIds.length) await tx.delete(alerts).where(inArray(alerts.id, plan.deleteIds));
    for (const { id, candidate } of plan.updates) {
      await tx.update(alerts).set({
        businessId: candidate.businessId,
        severity: candidate.severity,
        title: candidate.title,
        detail: candidate.detail,
        payload: { ...candidate.payload, dedupeKey: candidate.dedupeKey },
      }).where(eq(alerts.id, id));
    }
    if (plan.inserts.length) {
      await tx.insert(alerts).values(plan.inserts.map((candidate) => ({
        businessId: candidate.businessId,
        kind: candidate.kind,
        severity: candidate.severity,
        title: candidate.title,
        detail: candidate.detail,
        payload: { ...candidate.payload, dedupeKey: candidate.dedupeKey },
      })));
    }
  });
}

async function findDuplicateSubscriptions(): Promise<AlertCandidate[]> {
  const rows = await db.execute(sql`
    SELECT lower(regexp_replace(merchant, '\\W+', '', 'g')) AS merchant_key,
           count(DISTINCT business_id) AS business_count,
           array_agg(DISTINCT merchant) AS merchants
    FROM transactions
    LEFT JOIN categories ON transactions.category_id = categories.id
    WHERE amount_cents < 0
      AND coalesce(categories.tax_code, '') NOT LIKE 'exclude_%'
      AND NOT (coalesce(categories.tax_code, '') = 'income' OR lower(coalesce(categories.name, '')) IN ('income', 'revenue'))
      AND date >= current_date - interval '45 days'
    GROUP BY merchant_key
    HAVING count(DISTINCT business_id) > 1 AND count(*) > 1
    LIMIT 20
  `);
  return (rows.rows as Array<{ merchant_key: string; business_count: string; merchants: string[] }>)
    .filter((row) => row.merchant_key)
    .map((row) => ({
      dedupeKey: `dup:${row.merchant_key}`,
      businessId: null,
      kind: 'dup' as const,
      severity: 'warn' as const,
      title: `Possible duplicate subscription: ${row.merchants?.[0] ?? row.merchant_key}`,
      detail: `${row.merchants?.[0] ?? row.merchant_key} is billed across ${row.business_count} businesses in the last 45 days.`,
      payload: { merchantKey: row.merchant_key, businessCount: Number(row.business_count), merchants: row.merchants ?? [] },
    }));
}

async function findSpendSpikes(): Promise<AlertCandidate[]> {
  const activeBusinesses = await db.select().from(businesses).where(eq(businesses.active, true));
  const candidates: AlertCandidate[] = [];
  for (const business of activeBusinesses) {
    const rows = await db.execute(sql`
      WITH monthly AS (
        SELECT transactions.category_id,
               coalesce(categories.name, 'Uncategorized') AS category_name,
               date_trunc('month', date)::date AS month,
               abs(sum(amount_cents)) AS spend
        FROM transactions
        LEFT JOIN categories ON transactions.category_id = categories.id
        WHERE business_id = ${business.id}
          AND amount_cents < 0
          AND coalesce(categories.tax_code, '') NOT LIKE 'exclude_%'
          AND NOT (coalesce(categories.tax_code, '') = 'income' OR lower(coalesce(categories.name, '')) IN ('income', 'revenue'))
          AND date >= date_trunc('month', current_date) - interval '1 month'
        GROUP BY transactions.category_id, category_name, month
      )
      SELECT curr.category_id, curr.category_name, to_char(curr.month, 'YYYY-MM') AS month,
             curr.spend AS current_spend, prev.spend AS previous_spend
      FROM monthly curr
      JOIN monthly prev
        ON curr.category_id IS NOT DISTINCT FROM prev.category_id
       AND prev.month = date_trunc('month', current_date) - interval '1 month'
      WHERE curr.month = date_trunc('month', current_date)
        AND curr.spend - prev.spend > 50000
        AND curr.spend > prev.spend * 1.2
    `);
    for (const row of rows.rows as Array<{
      category_id: string | null;
      category_name: string;
      month: string;
      current_spend: string;
      previous_spend: string;
    }>) {
      candidates.push(spendSpikeCandidate({
        businessId: business.id,
        businessName: business.name,
        categoryId: row.category_id,
        categoryName: row.category_name,
        month: row.month,
        currentCents: Number(row.current_spend),
        previousCents: Number(row.previous_spend),
      }));
    }
  }
  return candidates;
}

export function spendSpikeCandidate(input: {
  businessId: string;
  businessName: string;
  categoryId: string | null;
  categoryName: string;
  month: string;
  currentCents: number;
  previousCents: number;
}): AlertCandidate {
  const pct = input.previousCents > 0
    ? Math.round(((input.currentCents - input.previousCents) / input.previousCents) * 100)
    : 0;
  const dollars = (cents: number) => `$${Math.round(cents / 100).toLocaleString('en-US')}`;
  return {
    dedupeKey: `spike:${input.businessId}:${input.categoryId ?? 'uncategorized'}:${input.month}`,
    businessId: input.businessId,
    kind: 'spike',
    severity: 'info',
    title: `${input.categoryName} spend up ${pct}% this month`,
    detail: `${input.businessName}: ${dollars(input.currentCents)} so far vs ${dollars(input.previousCents)} last month.`,
    payload: {
      categoryId: input.categoryId,
      categoryName: input.categoryName,
      month: input.month,
      currentCents: input.currentCents,
      previousCents: input.previousCents,
    },
  };
}
