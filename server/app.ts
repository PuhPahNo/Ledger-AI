import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import Fastify from 'fastify';
import { getEnv } from './config/env.js';
import { sendError } from './lib/errors.js';
import { authRoutes } from './routes/auth.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { connectionRoutes } from './routes/connections.js';
import { receiptRoutes } from './routes/receipts.js';
import { adminRoutes } from './routes/admin.js';
import { exportRoutes } from './routes/exports.js';
import { webhookRoutes } from './routes/webhooks.js';
import { storage } from './services/storage.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function buildApp() {
  const env = getEnv();
  const app = Fastify({
    logger: { level: env.NODE_ENV === 'development' ? 'debug' : 'info' },
  });

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    sendError(reply, error);
  });

  await app.register(fastifyCors, {
    origin: env.FRONTEND_ORIGIN,
    credentials: true,
  });
  await app.register(fastifyCookie, { secret: env.SESSION_SECRET });
  await app.register(fastifyRateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(fastifyMultipart, { limits: { fileSize: 25 * 1024 * 1024 } });
  await app.register(fastifySwagger, {
    openapi: {
      info: { title: 'Ledger AI API', version: '1.0.0' },
    },
  });
  await app.register(fastifySwaggerUi, { routePrefix: '/docs' });

  app.get('/healthz', async () => ({ ok: true }));

  await app.register(async (api) => {
    await authRoutes(api);
    await dashboardRoutes(api);
    await connectionRoutes(api);
    await receiptRoutes(api);
    await adminRoutes(api);
    await exportRoutes(api);
    await webhookRoutes(api);

    api.get('/files/:key', async (request, reply) => {
      const params = request.params as { key: string };
      const stream = await storage().getStream(decodeURIComponent(params.key));
      return reply.send(stream);
    });
  }, { prefix: '/api' });

  const distCandidates = [
    path.resolve(here, '../dist'),
    path.resolve(here, '../../dist'),
  ];
  const dist = distCandidates.find((candidate) => fs.existsSync(candidate)) ?? distCandidates[0];
  await app.register(fastifyStatic, {
    root: dist,
    prefix: '/',
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.raw.url?.startsWith('/api')) {
      return reply.status(404).send({ error: 'Not found' });
    }
    return reply.sendFile('index.html');
  });

  return app;
}
