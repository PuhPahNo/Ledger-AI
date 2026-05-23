import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { verifyPassword } from '../auth/password.js';
import { createSession, destroySession, getCurrentUser, requireUser } from '../auth/session.js';
import { createTotpSecret, toQrDataUrl, verifyTotp } from '../auth/totp.js';
import { unauthorized } from '../lib/errors.js';
import { audit } from '../services/audit.js';

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  totpCode: z.string().optional(),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get('/auth/me', async (request) => {
    const user = await getCurrentUser(request);
    return { user };
  });

  app.post('/auth/login', async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const user = await db.query.users.findFirst({
      where: and(eq(users.username, body.username), eq(users.active, true)),
    });
    if (!user || !(await verifyPassword(user.passwordHash, body.password))) {
      unauthorized('Invalid username or password');
    }
    if (user.totpEnabled) {
      if (!body.totpCode) return { requiresTotp: true };
      if (!user.totpSecret || !verifyTotp(user.totpSecret, body.totpCode)) {
        unauthorized('Invalid two-factor code');
      }
    }
    await createSession(reply, user);
    await db.update(users).set({ lastLoginAt: new Date(), updatedAt: new Date() }).where(eq(users.id, user.id));
    await audit(request, {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      totpEnabled: user.totpEnabled,
    }, 'login', 'user', user.id);
    return {
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        totpEnabled: user.totpEnabled,
      },
    };
  });

  app.post('/auth/logout', async (request, reply) => {
    const user = await getCurrentUser(request);
    await destroySession(request, reply);
    await audit(request, user, 'logout', 'user', user?.id);
    return { ok: true };
  });

  app.post('/auth/totp/setup', async (request) => {
    const user = await requireUser(request);
    const secret = createTotpSecret(user.username);
    await db.update(users).set({ totpSecret: secret.secret, totpEnabled: false, updatedAt: new Date() }).where(eq(users.id, user.id));
    return { otpauth: secret.otpauth, qrDataUrl: await toQrDataUrl(secret.otpauth) };
  });

  app.post('/auth/totp/enable', async (request) => {
    const user = await requireUser(request);
    const body = z.object({ code: z.string().min(6) }).parse(request.body);
    const row = await db.query.users.findFirst({ where: eq(users.id, user.id) });
    if (!row?.totpSecret || !verifyTotp(row.totpSecret, body.code)) unauthorized('Invalid two-factor code');
    await db.update(users).set({ totpEnabled: true, updatedAt: new Date() }).where(eq(users.id, user.id));
    return { ok: true };
  });
}
