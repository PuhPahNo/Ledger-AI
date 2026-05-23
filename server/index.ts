import { buildApp } from './app.js';
import { getEnv } from './config/env.js';
import { closeDb } from './db/client.js';
import { startWorkerLoop, type WorkerLoop } from './jobs/worker.js';

const app = await buildApp();
const env = getEnv();
let worker: WorkerLoop | null = null;
let shuttingDown = false;

const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await worker?.stop();
  await app.close();
  await closeDb();
};

process.on('SIGINT', () => void shutdown().then(() => process.exit(0)));
process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)));

await app.listen({ port: env.PORT, host: '0.0.0.0' });

if (env.RUN_WORKER_IN_WEB === 'true') {
  worker = startWorkerLoop();
}
