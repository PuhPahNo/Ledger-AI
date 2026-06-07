import { and, desc, eq, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { connections, jobs } from '../../db/schema.js';
import { isGmailWatchRenewalDue } from '../../jobs/scheduler.js';
import type { ApiConnectionHealth } from '../mappers.js';

export async function connectionHealthById(connectionRows: Array<typeof connections.$inferSelect>): Promise<Map<string, ApiConnectionHealth>> {
  const map = new Map<string, ApiConnectionHealth>();
  const ids = connectionRows.map((row) => row.id);
  const jobRows = ids.length
    ? await db
      .select()
      .from(jobs)
      .where(or(...ids.map((id) => sql`${jobs.payload} ->> 'connectionId' = ${id}`))!)
      .orderBy(desc(jobs.createdAt))
      .limit(Math.max(100, ids.length * 20))
    : [];
  const jobsByConnection = new Map<string, typeof jobRows>();
  for (const job of jobRows) {
    const connectionId = typeof job.payload.connectionId === 'string' ? job.payload.connectionId : null;
    if (!connectionId) continue;
    const list = jobsByConnection.get(connectionId) ?? [];
    list.push(job);
    jobsByConnection.set(connectionId, list);
  }

  for (const connection of connectionRows) {
    const metadata = connection.metadata ?? {};
    const relatedJobs = jobsByConnection.get(connection.id) ?? [];
    const lastJob = relatedJobs[0];
    map.set(connection.id, {
      lastSyncAt: connection.lastSyncAt?.toISOString() ?? null,
      lastWebhookAt: stringOrNull(metadata.lastWebhookAt),
      lastPubSubAt: stringOrNull(metadata.lastPubSubAt),
      gmailWatchExpiration: connection.gmailWatchExpiration?.toISOString() ?? null,
      gmailWatchRenewalDue: connection.kind === 'gmail'
        ? isGmailWatchRenewalDue(connection.gmailWatchExpiration ?? null)
        : false,
      lastJobType: lastJob?.type ?? null,
      lastJobStatus: lastJob?.status ?? null,
      lastJobAt: lastJob?.updatedAt.toISOString() ?? lastJob?.createdAt.toISOString() ?? null,
      lastJobError: lastJob?.lastError ?? null,
      queuedJobCount: relatedJobs.filter((job) => job.status === 'queued' || job.status === 'running').length,
      failedJobCount: relatedJobs.filter((job) => job.status === 'failed').length,
      actions: {
        canSync: connection.status === 'live',
        canBackfill: connection.status === 'live',
        gmailBackfillDays: connection.kind === 'gmail' ? [7, 30, 90, 365] : [],
        plaidBackfillMonths: connection.kind === 'gmail' ? [] : [12],
      },
    });
  }
  return map;
}

export async function failedSyncCountForBusiness(businessId: string | null): Promise<number> {
  const connectionRows = await db
    .select({ id: connections.id, status: connections.status })
    .from(connections)
    .where(and(
      sql`${connections.status} <> 'disconnected'`,
      businessId ? eq(connections.businessId, businessId) : sql`true`,
    ));
  const connectionIds = connectionRows.map((row) => row.id);
  if (!connectionIds.length) return 0;
  const [row] = await db
    .select({ count: sql<number>`count(${jobs.id})::int` })
    .from(jobs)
    .where(and(
      eq(jobs.status, 'failed'),
      or(...connectionIds.map((id) => sql`${jobs.payload} ->> 'connectionId' = ${id}`))!,
    ));
  return Number(row?.count ?? 0) + connectionRows.filter((connection) => connection.status === 'reauth').length;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
