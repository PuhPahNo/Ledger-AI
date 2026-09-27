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
import { HttpError, sendError } from './lib/errors.js';
import { authRoutes } from './routes/auth.js';
import { accountRoutes } from './routes/accounts.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { connectionRoutes } from './routes/connections.js';
import { receiptRoutes } from './routes/receipts.js';
import { receiptUploadPortalRoutes } from './routes/receiptUploadPortal.js';
import { adminRoutes } from './routes/admin.js';
import { assistantRoutes } from './routes/assistant.js';
import { exportRoutes } from './routes/exports.js';
import { webhookRoutes } from './routes/webhooks.js';
import { quickbooksRoutes } from './routes/quickbooks.js';
import { requireUser } from './auth/session.js';
import { storage, storedFileSecurityHeaders } from './services/storage.js';
import { redactSensitiveUrl } from './lib/urlRedaction.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function buildApp() {
  const env = getEnv();
  const app = Fastify({
    // Render terminates TLS in front of the app; trust only the configured number of
    // proxy hops so request.ip (rate limits, audit log) is the client, not the proxy,
    // without letting clients spoof it via a forged X-Forwarded-For prefix.
    trustProxy: env.TRUST_PROXY_HOPS > 0 ? env.TRUST_PROXY_HOPS : false,
    logger: {
      level: env.NODE_ENV === 'development' ? 'debug' : 'info',
      serializers: {
        req(request) {
          return {
            method: request.method,
            url: redactSensitiveUrl(request.url),
            host: request.host,
            remoteAddress: request.ip,
            remotePort: request.socket.remotePort,
          };
        },
      },
    },
  });

  // Baseline security headers. Deliberately no CSP on the SPA: Plaid Link (cdn.plaid.com
  // iframe/script) and Google Fonts must keep working. Routes may set stricter values.
  app.addHook('onSend', async (_request, reply, payload) => {
    if (!reply.hasHeader('X-Content-Type-Options')) reply.header('X-Content-Type-Options', 'nosniff');
    if (!reply.hasHeader('Referrer-Policy')) reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (!reply.hasHeader('X-Frame-Options')) reply.header('X-Frame-Options', 'SAMEORIGIN');
    if (env.NODE_ENV === 'production' && !reply.hasHeader('Strict-Transport-Security')) {
      reply.header('Strict-Transport-Security', 'max-age=15552000');
    }
    return payload;
  });

  app.setErrorHandler((error, _request, reply) => {
    // Framework/plugin client errors (rate limit 429, 413, 415, bad JSON…) keep their
    // status instead of falling through to a 500.
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (!(error instanceof HttpError) && typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send({ error: error instanceof Error ? error.message : 'Request error' });
    }
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
    await accountRoutes(api);
    await dashboardRoutes(api);
    await connectionRoutes(api);
    await receiptRoutes(api);
    await receiptUploadPortalRoutes(api);
    await adminRoutes(api);
    await assistantRoutes(api);
    await exportRoutes(api);
    await webhookRoutes(api);
    await quickbooksRoutes(api);

    // Local-driver download URLs (receipts, exports) point here; R2 uses signed URLs.
    // Admin session required; the key is confined to the storage root by the driver.
    api.get('/files/:key', async (request, reply) => {
      await requireUser(request);
      const params = request.params as { key: string };
      const key = decodeURIComponent(params.key);
      const stream = await storage().getStream(key);
      const fileName = (key.split('/').pop() || 'download').replace(/[^\x20-\x7e]|["\\]/g, '-').slice(0, 120);
      reply
        .headers(storedFileSecurityHeaders('application/octet-stream'))
        .header('Content-Type', 'application/octet-stream')
        .header('Content-Disposition', `attachment; filename="${fileName}"`)
        .header('Content-Security-Policy', 'sandbox');
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
