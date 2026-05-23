import { buildApp } from './app.js';
import { getEnv } from './config/env.js';
import { closeDb } from './db/client.js';

const app = await buildApp();
const env = getEnv();

const shutdown = async () => {
  await app.close();
  await closeDb();
};

process.on('SIGINT', () => void shutdown().then(() => process.exit(0)));
process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)));

await app.listen({ port: env.PORT, host: '0.0.0.0' });
