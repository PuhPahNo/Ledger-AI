import { closeDb } from '../db/client.js';
import { claimNextJob, markJobFailed, markJobSucceeded } from './queue.js';
import { handleJob } from './handlers.js';

type WorkerLogger = Pick<typeof console, 'error' | 'log'>;

export interface WorkerLoop {
  done: Promise<void>;
  stop: () => Promise<void>;
}

async function tick(logger: WorkerLogger): Promise<void> {
  const job = await claimNextJob();
  if (!job) return;
  try {
    await handleJob(job.type, job.payload);
    await markJobSucceeded(job.id);
    logger.log(`Job ${job.id} (${job.type}) succeeded`);
  } catch (error) {
    await markJobFailed(job.id, error);
    logger.error(`Job ${job.id} (${job.type}) failed`, error);
  }
}

export function startWorkerLoop(options: { pollMs?: number; logger?: WorkerLogger } = {}): WorkerLoop {
  const pollMs = options.pollMs ?? Number(process.env.JOB_POLL_MS ?? 5000);
  const logger = options.logger ?? console;
  let stopping = false;

  const done = (async () => {
    logger.log('Ledger AI worker started');
    while (!stopping) {
      try {
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
