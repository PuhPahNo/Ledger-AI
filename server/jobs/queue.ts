import { and, asc, eq, lte, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';

export type JobType =
  | 'plaid.sync'
  | 'gmail.sync'
  | 'gmail.renew-watch'
  | 'receipt.extract'
  | 'insights.generate'
  | 'export.build';

export async function enqueue(type: JobType, payload: Record<string, unknown> = {}, runAfter = new Date()): Promise<string> {
  const [job] = await db.insert(jobs).values({ type, payload, runAfter }).returning({ id: jobs.id });
  return job.id;
}

export async function claimNextJob() {
  const [job] = await db
    .select()
    .from(jobs)
    .where(and(
      or(eq(jobs.status, 'queued'), eq(jobs.status, 'failed')),
      lte(jobs.runAfter, new Date()),
      sql`${jobs.attempts} < ${jobs.maxAttempts}`,
    ))
    .orderBy(asc(jobs.runAfter), asc(jobs.createdAt))
    .limit(1);

  if (!job) return null;

  const [claimed] = await db
    .update(jobs)
    .set({ status: 'running', lockedAt: new Date(), attempts: job.attempts + 1, updatedAt: new Date() })
    .where(eq(jobs.id, job.id))
    .returning();
  return claimed;
}

export async function markJobSucceeded(jobId: string): Promise<void> {
  await db.update(jobs).set({ status: 'succeeded', updatedAt: new Date() }).where(eq(jobs.id, jobId));
}

export async function markJobFailed(jobId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await db.update(jobs).set({
    status: 'failed',
    lastError: message,
    runAfter: new Date(Date.now() + 60_000),
    updatedAt: new Date(),
  }).where(eq(jobs.id, jobId));
}
