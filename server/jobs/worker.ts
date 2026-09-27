import { closeDb } from '../db/client.js';
import {
  JOB_HEARTBEAT_MS,
  claimNextJob,
  enqueue,
  heartbeatJob,
  markJobFailed,
  markJobSucceeded,
  reclaimStaleJobs,
} from './queue.js';
import { handleJob } from './handlers.js';
import {
  enqueueDueCategorizationScan,
  enqueueDueGmailWatchRenewals,
  enqueueDuePlaidSyncs,
  enqueueDueQuickbooksSyncs,
  enqueueDueReceiptRematch,
  enqueuePendingReceiptExtractions,
} from './scheduler.js';

type WorkerLogger = Pick<typeof console, 'error' | 'log'>;

export interface WorkerLoop {
  done: Promise<void>;
  stop: () => Promise<void>;
}

const SCHEDULE_CHECK_MS = 60 * 60 * 1000;
const STALE_JOB_CHECK_MS = 5 * 60 * 1000;

async function tick(logger: WorkerLogger): Promise<void> {
  const job = await claimNextJob();
  if (!job) return;
  // Keep lockedAt fresh so reclaimStaleJobs can tell a long-running job from a dead one.
  const heartbeat = setInterval(() => {
    heartbeatJob(job.id, job.attempts).catch((error) => logger.error(`Job ${job.id} heartbeat failed`, error));
  }, JOB_HEARTBEAT_MS);
  try {
    await handleJob(job.type, job.payload);
    await markJobSucceeded(job.id, job.attempts);
    logger.log(`Job ${job.id} (${job.type}) succeeded`);
  } catch (error) {
    await markJobFailed(job.id, error, job.attempts);
    logger.error(`Job ${job.id} (${job.type}) failed`, error);
  } finally {
    clearInterval(heartbeat);
  }
}

async function reclaim(logger: WorkerLogger): Promise<void> {
  const reclaimed = await reclaimStaleJobs();
  for (const job of reclaimed) {
    logger.log(`Reclaimed stale job ${job.id} (${job.type}) -> ${job.status}`);
  }
}

export function startWorkerLoop(options: { pollMs?: number; logger?: WorkerLogger } = {}): WorkerLoop {
  const pollMs = options.pollMs ?? Number(process.env.JOB_POLL_MS ?? 5000);
  const logger = options.logger ?? console;
  let stopping = false;
  let nextScheduleCheckAt = 0;
  let nextStaleJobCheckAt = 0;

  const done = (async () => {
    logger.log('Ledger AI worker started');
    // Force one re-match pass on boot so a deploy immediately re-pairs the existing
    // backlog with the latest matching logic (the periodic sweep is throttled to 6h).
    try {
      await enqueue('receipt.rematch', {});
      logger.log('Queued startup receipt re-match sweep');
    } catch (error) {
      logger.error('Failed to queue startup receipt re-match', error);
    }
    while (!stopping) {
      try {
        // Runs on boot (first iteration) and every few minutes: jobs orphaned by a crash or
        // redeploy would otherwise sit in 'running' forever and block their scheduler slot.
        if (Date.now() >= nextStaleJobCheckAt) {
          nextStaleJobCheckAt = Date.now() + STALE_JOB_CHECK_MS;
          await reclaim(logger);
        }
        if (Date.now() >= nextScheduleCheckAt) {
          nextScheduleCheckAt = Date.now() + SCHEDULE_CHECK_MS;
          const queued = await enqueueDuePlaidSyncs();
          if (queued > 0) logger.log(`Queued ${queued} daily Plaid sync job${queued === 1 ? '' : 's'}`);
          const gmailWatchQueued = await enqueueDueGmailWatchRenewals();
          if (gmailWatchQueued > 0) logger.log(`Queued ${gmailWatchQueued} Gmail watch renewal job${gmailWatchQueued === 1 ? '' : 's'}`);
          const categorizationQueued = await enqueueDueCategorizationScan();
          if (categorizationQueued > 0) logger.log('Queued daily categorization review scan');
          const receiptExtractionsQueued = await enqueuePendingReceiptExtractions();
          if (receiptExtractionsQueued > 0) {
            logger.log(`Queued ${receiptExtractionsQueued} pending receipt extraction job${receiptExtractionsQueued === 1 ? '' : 's'}`);
          }
          const receiptRematchQueued = await enqueueDueReceiptRematch();
          if (receiptRematchQueued > 0) logger.log('Queued receipt re-match sweep');
          const quickbooksQueued = await enqueueDueQuickbooksSyncs();
          if (quickbooksQueued > 0) logger.log(`Queued ${quickbooksQueued} daily QuickBooks sync job${quickbooksQueued === 1 ? '' : 's'}`);
        }
        await tick(logger);
      } catch (error) {
        logger.error('Ledger AI worker tick failed', error);
      }
      if (!stopping) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    }
    logger.log('Ledger AI worker stopped');
  })();

  return {
    done,
    stop: async () => {
      stopping = true;
      await done;
    },
  };
}

async function main(): Promise<void> {
  const worker = startWorkerLoop();
  const shutdown = () => {
    void worker.stop();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  try {
    await worker.done;
  } finally {
    await closeDb();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
