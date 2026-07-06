import { and, asc, eq, lte, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';

export type JobType =
  | 'plaid.sync'
  | 'gmail.sync'
  | 'gmail.backfill'
  | 'gmail.renew-watch'
  | 'receipt.extract'
  | 'receipt.rematch'
  | 'categorization.apply-rule'
  | 'categorization.scan-uncategorized'
  | 'categorization.receipt-evidence-review'
  | 'insights.generate'
  | 'export.build';

export async function enqueue(type: JobType, payload: Record<string, unknown> = {}, runAfter = new Date()): Promise<string> {
  const [job] = await db.insert(jobs).values({ type, payload, runAfter }).returning({ id: jobs.id });
  return job.id;
}

export async function claimNextJob() {
  return db.transaction(async (tx) => {
    const [job] = await tx
      .select()
      .from(jobs)
      .where(and(
        or(eq(jobs.status, 'queued'), eq(jobs.status, 'failed')),
        lte(jobs.runAfter, new Date()),
        sql`${jobs.attempts} < ${jobs.maxAttempts}`,
      ))
      .orderBy(asc(jobs.runAfter), asc(jobs.createdAt))
      .limit(1)
      .for('update', { skipLocked: true });

    if (!job) return null;

    const [claimed] = await tx
      .update(jobs)
      .set({ status: 'running', lockedAt: new Date(), attempts: job.attempts + 1, updatedAt: new Date() })
      .where(eq(jobs.id, job.id))
      .returning();
    return claimed ?? null;
  });
}

export async function markJobSucceeded(jobId: string): Promise<void> {
  await db.update(jobs).set({ status: 'succeeded', lastError: null, updatedAt: new Date() }).where(eq(jobs.id, jobId));
}

export async function markJobFailed(jobId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await db.update(jobs).set({
    status: 'failed',
    lastError: message,
    // Exponential backoff with jitter (60s, 2m, 4m, 8m… capped at 1h) — the previous
    // fixed 60s retry burned all attempts within minutes while a provider was down.
    runAfter: sql`now() + (least(3600, 60 * power(2, greatest(${jobs.attempts} - 1, 0))) + floor(random() * 30)) * interval '1 second'`,
    updatedAt: new Date(),
  }).where(eq(jobs.id, jobId));
}
