import { describe, expect, it } from 'vitest';
import { STALE_JOB_LOCK_MS, isJobLockStale, staleRunningJobsQuery } from './queue.js';

describe('isJobLockStale', () => {
  const now = new Date('2026-09-27T12:00:00.000Z');

  it('treats running jobs with no lock as stale', () => {
    expect(isJobLockStale(null, now)).toBe(true);
  });

  it('keeps jobs whose heartbeat is inside the threshold', () => {
    expect(isJobLockStale(new Date(now.getTime() - STALE_JOB_LOCK_MS), now)).toBe(false);
  });

  it('reclaims jobs whose lock is older than the threshold', () => {
    expect(isJobLockStale(new Date(now.getTime() - STALE_JOB_LOCK_MS - 1), now)).toBe(true);
  });

  it('uses a threshold far above the heartbeat interval', () => {
    expect(STALE_JOB_LOCK_MS).toBeGreaterThanOrEqual(30 * 60 * 1000);
  });
});

describe('staleRunningJobsQuery', () => {
  it('only touches running jobs with an old or missing lock and requeues while attempts remain', () => {
    const now = new Date('2026-09-27T12:00:00.000Z');
    const query = staleRunningJobsQuery(now).toSQL();
    expect(query.sql).toContain('update "jobs"');
    expect(query.sql).toMatch(/"jobs"\."status" = \$\d+/);
    expect(query.sql).toMatch(/"jobs"\."locked_at" is null or "jobs"\."locked_at" < \$\d+/);
    expect(query.sql).toContain(`CASE WHEN "jobs"."attempts" < "jobs"."max_attempts" THEN 'queued'::job_status ELSE 'failed'::job_status END`);
    expect(query.params).toContain('running');
    const cutoff = new Date(now.getTime() - STALE_JOB_LOCK_MS).toISOString();
    expect(query.params.map(String)).toContain(cutoff);
  });
});
