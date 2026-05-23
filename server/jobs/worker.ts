import { closeDb } from '../db/client.js';
import { claimNextJob, markJobFailed, markJobSucceeded } from './queue.js';
import { handleJob } from './handlers.js';

const pollMs = Number(process.env.JOB_POLL_MS ?? 5000);
let stopping = false;

process.on('SIGINT', () => {
  stopping = true;
});
process.on('SIGTERM', () => {
  stopping = true;
});

async function tick(): Promise<void> {
  const job = await claimNextJob();
  if (!job) return;
  try {
    await handleJob(job.type, job.payload);
    await markJobSucceeded(job.id);
    console.log(`Job ${job.id} (${job.type}) succeeded`);
  } catch (error) {
    await markJobFailed(job.id, error);
    console.error(`Job ${job.id} (${job.type}) failed`, error);
  }
}

async function main(): Promise<void> {
  console.log('Ledger AI worker started');
  while (!stopping) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  await closeDb();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
