import { and, asc, eq, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';

export type JobType =
  | 'plaid.sync'
  | 'gmail.sync'
  | 'gmail.backfill'
  | 'gmail.renew-watch'
  | 'receipt.extract'
  | 'receipt.rematch'
  | 'receipt.waiver-evidence'
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

/**
 * A failure retrying can't fix (bad input, a state only a person can resolve). The job is
 * marked failed with its attempts exhausted so it isn't re-run 4 more times.
 */
export class NonRetryableJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableJobError';
  }
}

/**
 * A job is 'running' only while a worker holds it, and the worker refreshes lockedAt every
 * JOB_HEARTBEAT_MS. A lock older than this means the worker died (crash, redeploy, OOM).
 * Heartbeats keep legitimately long jobs (365-day gmail.backfill, big export.build zips)
 * from ever looking stale, so the threshold only has to cover a few missed heartbeats.
 */
export const JOB_HEARTBEAT_MS = 60 * 1000;
export const STALE_JOB_LOCK_MS = 30 * 60 * 1000;
export const STALE_JOB_ERROR = 'Worker stopped while this job was running (crash or redeploy); requeued automatically.';

export function isJobLockStale(lockedAt: Date | null | undefined, now = new Date(), thresholdMs = STALE_JOB_LOCK_MS): boolean {
  return !lockedAt || now.getTime() - lockedAt.getTime() > thresholdMs;
}

export function staleRunningJobsQuery(now = new Date(), thresholdMs = STALE_JOB_LOCK_MS) {
  const cutoff = new Date(now.getTime() - thresholdMs);
  // The claim already counted this run as an attempt, so a job that keeps killing the
  // worker still exhausts maxAttempts and ends up 'failed' instead of looping forever.
  return db
    .update(jobs)
    .set({
      status: sql`CASE WHEN ${jobs.attempts} < ${jobs.maxAttempts} THEN 'queued'::job_status ELSE 'failed'::job_status END`,
      lockedAt: null,
      lastError: STALE_JOB_ERROR,
      runAfter: now,
      updatedAt: now,
    })
    .where(and(
      eq(jobs.status, 'running'),
      or(isNull(jobs.lockedAt), lt(jobs.lockedAt, cutoff)),
    ))
    .returning({ id: jobs.id, type: jobs.type, status: jobs.status });
}

/** Return orphaned 'running' jobs to the queue. Safe to call from any worker at any time. */
export async function reclaimStaleJobs(now = new Date(), thresholdMs = STALE_JOB_LOCK_MS) {
  return staleRunningJobsQuery(now, thresholdMs);
}

export async function heartbeatJob(jobId: string, attempt: number): Promise<void> {
  await db
    .update(jobs)
    .set({ lockedAt: new Date() })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, 'running'), eq(jobs.attempts, attempt)));
}

/** `attempt` guards against a reclaimed-and-reclaimed job being overwritten by a zombie run. */
function ownedBy(jobId: string, attempt?: number) {
  return attempt == null ? eq(jobs.id, jobId) : and(eq(jobs.id, jobId), eq(jobs.attempts, attempt));
}

export async function markJobSucceeded(jobId: string, attempt?: number): Promise<void> {
  await db.update(jobs)
    .set({ status: 'succeeded', lastError: null, lockedAt: null, updatedAt: new Date() })
    .where(ownedBy(jobId, attempt));
}

export async function markJobFailed(jobId: string, error: unknown, attempt?: number): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const permanent = error instanceof NonRetryableJobError;
  await db.update(jobs).set({
    status: 'failed',
    lastError: message,
    lockedAt: null,
    ...(permanent ? { attempts: sql`greatest(${jobs.attempts}, ${jobs.maxAttempts})` } : {}),
    // Exponential backoff with jitter (60s, 2m, 4m, 8m… capped at 1h) — the previous
    // fixed 60s retry burned all attempts within minutes while a provider was down.
    runAfter: sql`now() + (least(3600, 60 * power(2, greatest(${jobs.attempts} - 1, 0))) + floor(random() * 30)) * interval '1 second'`,
    updatedAt: new Date(),
  }).where(ownedBy(jobId, attempt));
}
