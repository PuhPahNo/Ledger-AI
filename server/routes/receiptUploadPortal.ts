import type { FastifyInstance, FastifyRequest } from 'fastify';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { verifyPassword } from '../auth/password.js';
import { createSession, destroySession, getCurrentUser, type AuthedUser } from '../auth/session.js';
import { verifyTotp } from '../auth/totp.js';
import {
  createReceiptUploaderSession,
  destroyReceiptUploaderSession,
  getCurrentReceiptUploader,
} from '../auth/uploaderSession.js';
import { db } from '../db/client.js';
import { businesses, receiptUploaders, receipts, users, type User } from '../db/schema.js';
import { enqueue } from '../jobs/queue.js';
import { badRequest, unauthorized } from '../lib/errors.js';
import { sha256Buffer } from '../lib/crypto.js';
import { audit } from '../services/audit.js';
import { storage } from '../services/storage.js';

const supportedMimeTypes = new Set([
  'application/pdf',
  'text/plain',
  'text/html',
]);

type ReceiptUploadActor = {
  id: string;
  username: string;
  displayName: string;
  businessId: string | null;
  accountType: 'receipt_uploader' | 'admin';
  totpEnabled?: boolean;
};

export async function receiptUploadPortalRoutes(app: FastifyInstance): Promise<void> {
  app.get('/receipt-upload/me', async (request) => {
    const uploader = await getCurrentReceiptUploadActor(request);
    return { uploader: uploader ? await toPortalUploader(uploader) : null };
  });

  app.post('/receipt-upload/login', async (request, reply) => {
    const body = z.object({
      username: z.string().min(1),
      password: z.string().min(1),
      totpCode: z.string().optional(),
    }).parse(request.body);
    const uploader = await db.query.receiptUploaders.findFirst({
      where: and(eq(receiptUploaders.username, body.username), eq(receiptUploaders.active, true)),
    });
    if (uploader && await verifyPassword(uploader.passwordHash, body.password)) {
      await createReceiptUploaderSession(reply, uploader);
      await db.update(receiptUploaders).set({ lastLoginAt: new Date(), updatedAt: new Date() }).where(eq(receiptUploaders.id, uploader.id));
      await audit(request, null, 'receipt_uploader_login', 'receipt_uploader', uploader.id);
      return { uploader: await toPortalUploader({ ...uploader, accountType: 'receipt_uploader' }) };
    }

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
    await audit(request, toAuditUser(user), 'receipt_upload_admin_login', 'user', user.id);
    return { uploader: await toPortalUploader(toAdminReceiptUploadActor(user)) };
  });

  app.post('/receipt-upload/logout', async (request, reply) => {
    const uploader = await getCurrentReceiptUploadActor(request);
    await destroyReceiptUploaderSession(request, reply);
    await destroySession(request, reply);
    await audit(
      request,
      uploader?.accountType === 'admin' ? toAuditUser(uploader) : null,
      uploader?.accountType === 'admin' ? 'receipt_upload_admin_logout' : 'receipt_uploader_logout',
      uploader?.accountType === 'admin' ? 'user' : 'receipt_uploader',
      uploader?.id,
    );
    return { ok: true };
  });

  app.post('/receipt-upload/receipts', async (request) => {
    const uploader = await requireReceiptUploadActor(request);
    const file = await request.file();
    if (!file) badRequest('Missing receipt file');
    if (!isSupportedReceiptUpload(file.mimetype, file.filename)) {
      badRequest('Upload a receipt image, PDF, text, or HTML file.');
    }

    const chunks: Buffer[] = [];
    for await (const chunk of file.file) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);
    const fileSha256 = sha256Buffer(buffer);
    const duplicate = await db.query.receipts.findFirst({
      where: and(uploadedByActorPredicate(uploader), eq(receipts.fileSha256, fileSha256)),
    });
    if (duplicate) {
      await audit(request, toAuditUser(uploader), duplicateAuditAction(uploader), 'receipt', duplicate.id, actorAuditMetadata(uploader));
      return {
        receiptId: duplicate.id,
        duplicate: true,
        processing: false,
        message: 'This receipt was already uploaded from this account.',
      };
    }

    const safeName = sanitizeFileName(file.filename);
    const key = `receipts/employee/${uploader.accountType}/${uploader.id}/${new Date().toISOString().slice(0, 10)}/${cryptoRandom()}-${safeName}`;
    await storage().put({ key, body: buffer, contentType: file.mimetype });
    const [receipt] = await db.insert(receipts).values({
      businessId: uploader.businessId,
      source: 'upload',
      status: 'pending',
      fileKey: key,
      fileName: safeName,
      mimeType: file.mimetype,
      fileSha256,
      uploadedByUserId: uploader.accountType === 'admin' ? uploader.id : null,
      uploadedByUploaderId: uploader.accountType === 'receipt_uploader' ? uploader.id : null,
      ocrJson: {
        contentKind: 'employee_upload',
        uploadActorType: uploader.accountType,
        uploadActorId: uploader.id,
        uploadActorUsername: uploader.username,
      },
    }).returning({ id: receipts.id });

    await enqueue('receipt.extract', { receiptId: receipt.id });
    await audit(request, toAuditUser(uploader), uploadAuditAction(uploader), 'receipt', receipt.id, {
      ...actorAuditMetadata(uploader),
      fileName: safeName,
    });
    return { receiptId: receipt.id, duplicate: false, processing: true };
  });
}

async function getCurrentReceiptUploadActor(request: FastifyRequest): Promise<ReceiptUploadActor | null> {
  const uploader = await getCurrentReceiptUploader(request);
  if (uploader) return { ...uploader, accountType: 'receipt_uploader' };
  const user = await getCurrentUser(request);
  return user ? toAdminReceiptUploadActor(user) : null;
}

async function requireReceiptUploadActor(request: FastifyRequest): Promise<ReceiptUploadActor> {
  const uploader = await getCurrentReceiptUploadActor(request);
  if (!uploader) unauthorized();
  return uploader;
}

function toAdminReceiptUploadActor(user: AuthedUser | User): ReceiptUploadActor {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    businessId: null,
    accountType: 'admin',
    totpEnabled: user.totpEnabled,
  };
}

function toAuditUser(actor: ReceiptUploadActor | User | null | undefined): AuthedUser | null {
  if (!actor) return null;
  if ('accountType' in actor && actor.accountType !== 'admin') return null;
  return {
    id: actor.id,
    username: actor.username,
    displayName: actor.displayName,
    role: 'admin',
    totpEnabled: actor.totpEnabled ?? false,
  };
}

function uploadedByActorPredicate(actor: ReceiptUploadActor) {
  return actor.accountType === 'admin'
    ? eq(receipts.uploadedByUserId, actor.id)
    : eq(receipts.uploadedByUploaderId, actor.id);
}

function actorAuditMetadata(actor: ReceiptUploadActor): Record<string, unknown> {
  return actor.accountType === 'admin'
    ? { adminUserId: actor.id }
    : { uploaderId: actor.id };
}

function duplicateAuditAction(actor: ReceiptUploadActor): string {
  return actor.accountType === 'admin'
    ? 'receipt_upload_admin_duplicate_receipt'
    : 'receipt_uploader_duplicate_receipt';
}

function uploadAuditAction(actor: ReceiptUploadActor): string {
  return actor.accountType === 'admin'
    ? 'receipt_upload_admin_upload_receipt'
    : 'receipt_uploader_upload_receipt';
}

async function toPortalUploader(uploader: ReceiptUploadActor) {
  const business = uploader.businessId
    ? await db.query.businesses.findFirst({ where: eq(businesses.id, uploader.businessId) })
    : null;
  return {
    id: uploader.id,
    username: uploader.username,
    displayName: uploader.displayName,
    accountType: uploader.accountType,
    businessId: uploader.businessId,
    businessName: uploader.accountType === 'admin' ? 'Admin account' : business?.name ?? null,
  };
}

function isSupportedReceiptUpload(mimeType: string, fileName: string): boolean {
  if (mimeType.startsWith('image/') || supportedMimeTypes.has(mimeType)) return true;
  return /\.(pdf|png|jpe?g|webp|heic|heif|gif|txt|html?)$/i.test(fileName);
}

function sanitizeFileName(fileName: string): string {
  const parsed = path.parse(fileName);
  const base = parsed.name.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 80) || 'receipt';
  const ext = parsed.ext.replace(/[^a-z0-9.]+/gi, '').slice(0, 12);
  return `${base}${ext}`;
}

function cryptoRandom(): string {
  return Math.random().toString(36).slice(2, 10);
}
