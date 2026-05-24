import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { connections, jobs } from '../db/schema.js';
import { enqueue } from './queue.js';

export const DAILY_PLAID_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function isPlaidConnectionDueForDailySync(
  lastSyncAt: Date | null | undefined,
  now = new Date(),
): boolean {
  return !lastSyncAt || now.getTime() - lastSyncAt.getTime() >= DAILY_PLAID_SYNC_INTERVAL_MS;
}

export async function enqueueDuePlaidSyncs(now = new Date()): Promise<number> {
  const rows = await db
    .select({
      id: connections.id,
      lastSyncAt: connections.lastSyncAt,
    })
    .from(connections)
    .where(and(
      sql`${connections.kind} <> 'gmail'`,
      eq(connections.status, 'live'),
      sql`${connections.encryptedAccessToken} IS NOT NULL`,
    ));

  let queued = 0;
  for (const row of rows) {
    if (!isPlaidConnectionDueForDailySync(row.lastSyncAt, now)) continue;
    if (await hasPendingPlaidSync(row.id)) continue;
    await enqueue('plaid.sync', { connectionId: row.id }, now);
    queued += 1;
  }
  return queued;
}

async function hasPendingPlaidSync(connectionId: string): Promise<boolean> {
  const [existing] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(
      eq(jobs.type, 'plaid.sync'),
      inArray(jobs.status, ['queued', 'running', 'failed']),
      sql`${jobs.attempts} < ${jobs.maxAttempts}`,
      sql`${jobs.payload} ->> 'connectionId' = ${connectionId}`,
    ))
    .limit(1);

  return Boolean(existing);
}
