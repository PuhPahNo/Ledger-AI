import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, gt } from 'drizzle-orm';
import { isProduction } from '../config/env.js';
import { db } from '../db/client.js';
import { receiptUploaderSessions, receiptUploaders, type ReceiptUploader } from '../db/schema.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { unauthorized } from '../lib/errors.js';

export const receiptUploaderSessionCookie = 'ledger_receipt_upload_session';
const sessionDays = 30;

export interface AuthedReceiptUploader {
  id: string;
  username: string;
  displayName: string;
  businessId: string | null;
}

export async function createReceiptUploaderSession(reply: FastifyReply, uploader: ReceiptUploader): Promise<void> {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + sessionDays * 24 * 60 * 60 * 1000);
  await db.insert(receiptUploaderSessions).values({
    uploaderId: uploader.id,
    tokenHash: sha256(token),
    expiresAt,
  });
  reply.setCookie(receiptUploaderSessionCookie, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction(),
    path: '/',
    expires: expiresAt,
  });
}

export async function destroyReceiptUploaderSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.cookies[receiptUploaderSessionCookie];
  if (token) {
    await db.delete(receiptUploaderSessions).where(eq(receiptUploaderSessions.tokenHash, sha256(token)));
  }
  reply.clearCookie(receiptUploaderSessionCookie, { path: '/' });
}

export async function requireReceiptUploader(request: FastifyRequest): Promise<AuthedReceiptUploader> {
  const uploader = await getCurrentReceiptUploader(request);
  if (!uploader) unauthorized();
  return uploader;
}

export async function getCurrentReceiptUploader(request: FastifyRequest): Promise<AuthedReceiptUploader | null> {
  const token = request.cookies[receiptUploaderSessionCookie];
  if (!token) return null;
  const session = await db.query.receiptUploaderSessions.findFirst({
    where: and(eq(receiptUploaderSessions.tokenHash, sha256(token)), gt(receiptUploaderSessions.expiresAt, new Date())),
  });
  if (!session) return null;
  const uploader = await db.query.receiptUploaders.findFirst({
    where: and(eq(receiptUploaders.id, session.uploaderId), eq(receiptUploaders.active, true)),
  });
  if (!uploader) return null;
  return {
    id: uploader.id,
    username: uploader.username,
    displayName: uploader.displayName,
    businessId: uploader.businessId,
  };
}
