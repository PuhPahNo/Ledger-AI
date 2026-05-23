import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { alerts, businesses, receipts, transactions } from '../db/schema.js';

export async function regenerateInsights(): Promise<void> {
  await db.delete(alerts).where(eq(alerts.status, 'open'));
  await generateMissingReceiptAlerts();
  await generateOrphanReceiptAlerts();
  await generateDuplicateSubscriptionAlerts();
  await generateSpendSpikeAlerts();
}

async function generateMissingReceiptAlerts(): Promise<void> {
  const rows = await db
    .select({
      businessId: transactions.businessId,
      count: sql<number>`count(*)::int`,
    })
    .from(transactions)
    .where(and(eq(transactions.receiptStatus, 'missing'), lt(transactions.date, sql`current_date - interval '7 days'`)))
    .groupBy(transactions.businessId);

  for (const row of rows) {
    if (!row.count) continue;
    await db.insert(alerts).values({
      businessId: row.businessId,
      kind: 'missing',
      severity: 'todo',
      title: `${row.count} transactions need receipts`,
      detail: 'Transactions are past the 7-day receipt SLA.',
      payload: { count: row.count },
    });
  }
}

async function generateOrphanReceiptAlerts(): Promise<void> {
  const rows = await db
    .select({
      businessId: receipts.businessId,
      count: sql<number>`count(*)::int`,
    })
    .from(receipts)
    .where(and(isNull(receipts.transactionId), lt(receipts.createdAt, sql`now() - interval '14 days'`)))
    .groupBy(receipts.businessId);

  for (const row of rows) {
    await db.insert(alerts).values({
      businessId: row.businessId,
      kind: 'orphan',
      severity: 'info',
      title: `${row.count} receipts without transactions`,
      detail: 'Receipts have not matched a Plaid transaction after 14 days.',
      payload: { count: row.count },
    });
  }
}

async function generateDuplicateSubscriptionAlerts(): Promise<void> {
  const rows = await db.execute(sql`
    SELECT lower(regexp_replace(merchant, '\\W+', '', 'g')) AS merchant_key,
           count(DISTINCT business_id) AS business_count,
           array_agg(DISTINCT merchant) AS merchants
    FROM transactions
    WHERE amount_cents < 0
      AND date >= current_date - interval '45 days'
    GROUP BY merchant_key
    HAVING count(DISTINCT business_id) > 1 AND count(*) > 1
    LIMIT 20
  `);

  for (const row of rows.rows as Array<{ merchant_key: string; business_count: string; merchants: string[] }>) {
    await db.insert(alerts).values({
      kind: 'dup',
      severity: 'warn',
      title: 'Possible duplicate subscription',
      detail: `${row.merchants?.[0] ?? row.merchant_key} is billed across ${row.business_count} businesses.`,
      payload: row,
    });
  }
}

async function generateSpendSpikeAlerts(): Promise<void> {
  const activeBusinesses = await db.select().from(businesses).where(eq(businesses.active, true));
  for (const business of activeBusinesses) {
    const rows = await db.execute(sql`
      WITH monthly AS (
        SELECT category_id,
               date_trunc('month', date)::date AS month,
               abs(sum(amount_cents)) AS spend
        FROM transactions
        WHERE business_id = ${business.id}
          AND amount_cents < 0
          AND date >= date_trunc('month', current_date) - interval '1 month'
        GROUP BY category_id, month
      )
      SELECT curr.category_id, curr.spend AS current_spend, prev.spend AS previous_spend
      FROM monthly curr
      LEFT JOIN monthly prev
        ON curr.category_id = prev.category_id
       AND prev.month = date_trunc('month', current_date) - interval '1 month'
      WHERE curr.month = date_trunc('month', current_date)
        AND prev.spend IS NOT NULL
        AND curr.spend - prev.spend > 50000
        AND curr.spend > prev.spend * 1.2
    `);

    for (const row of rows.rows as Array<{ category_id: string; current_spend: string; previous_spend: string }>) {
      await db.insert(alerts).values({
        businessId: business.id,
        kind: 'spike',
        severity: 'info',
        title: 'Spend spike detected',
        detail: `${business.name} category spend increased more than 20% and $500 this month.`,
        payload: row,
      });
    }
  }
}
