import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, gt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { sessions, users, type User } from '../db/schema.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { unauthorized } from '../lib/errors.js';
import { isProduction } from '../config/env.js';

export const sessionCookie = 'ledger_session';
const sessionDays = 14;

export interface AuthedUser {
  id: string;
  username: string;
  displayName: string;
  role: 'admin';
  totpEnabled: boolean;
}

export async function createSession(reply: FastifyReply, user: User): Promise<void> {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + sessionDays * 24 * 60 * 60 * 1000);
  await db.insert(sessions).values({
    userId: user.id,
    tokenHash: sha256(token),
    expiresAt,
  });
  reply.setCookie(sessionCookie, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction(),
    path: '/',
    expires: expiresAt,
  });
}

export async function destroySession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.cookies[sessionCookie];
  if (token) {
    await db.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
  }
  reply.clearCookie(sessionCookie, { path: '/' });
}

export async function requireUser(request: FastifyRequest): Promise<AuthedUser> {
  const user = await getCurrentUser(request);
  if (!user) unauthorized();
  return user;
}

export async function getCurrentUser(request: FastifyRequest): Promise<AuthedUser | null> {
  const token = request.cookies[sessionCookie];
  if (!token) return null;
  const session = await db.query.sessions.findFirst({
    where: and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, new Date())),
  });
  if (!session) return null;
  const user = await db.query.users.findFirst({
    where: and(eq(users.id, session.userId), eq(users.active, true)),
  });
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    totpEnabled: user.totpEnabled,
  };
}
