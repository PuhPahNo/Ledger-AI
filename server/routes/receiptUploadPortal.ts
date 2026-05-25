import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { verifyPassword } from '../auth/password.js';
import {
  createReceiptUploaderSession,
  destroyReceiptUploaderSession,
  getCurrentReceiptUploader,
  requireReceiptUploader,
} from '../auth/uploaderSession.js';
import { db } from '../db/client.js';
import { businesses, receiptUploaders, receipts } from '../db/schema.js';
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

export async function receiptUploadPortalRoutes(app: FastifyInstance): Promise<void> {
  app.get('/receipt-upload/me', async (request) => {
    const uploader = await getCurrentReceiptUploader(request);
    return { uploader: uploader ? await toPortalUploader(uploader) : null };
  });

  app.post('/receipt-upload/login', async (request, reply) => {
    const body = z.object({
      username: z.string().min(1),
      password: z.string().min(1),
    }).parse(request.body);
    const uploader = await db.query.receiptUploaders.findFirst({
      where: and(eq(receiptUploaders.username, body.username), eq(receiptUploaders.active, true)),
    });
    if (!uploader || !(await verifyPassword(uploader.passwordHash, body.password))) {
      unauthorized('Invalid username or password');
    }
    await createReceiptUploaderSession(reply, uploader);
    await db.update(receiptUploaders).set({ lastLoginAt: new Date(), updatedAt: new Date() }).where(eq(receiptUploaders.id, uploader.id));
    await audit(request, null, 'receipt_uploader_login', 'receipt_uploader', uploader.id);
    return { uploader: await toPortalUploader(uploader) };
  });

  app.post('/receipt-upload/logout', async (request, reply) => {
    const uploader = await getCurrentReceiptUploader(request);
    await destroyReceiptUploaderSession(request, reply);
    await audit(request, null, 'receipt_uploader_logout', 'receipt_uploader', uploader?.id);
    return { ok: true };
  });

  app.post('/receipt-upload/receipts', async (request) => {
    const uploader = await requireReceiptUploader(request);
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
      where: and(
        eq(receipts.uploadedByUploaderId, uploader.id),
        eq(receipts.fileSha256, fileSha256),
      ),
    });
    if (duplicate) {
      await audit(request, null, 'receipt_uploader_duplicate_receipt', 'receipt', duplicate.id, { uploaderId: uploader.id });
      return {
        receiptId: duplicate.id,
        duplicate: true,
        processing: false,
        message: 'This receipt was already uploaded from this account.',
      };
    }

    const safeName = sanitizeFileName(file.filename);
    const key = `receipts/employee/${uploader.id}/${new Date().toISOString().slice(0, 10)}/${cryptoRandom()}-${safeName}`;
    await storage().put({ key, body: buffer, contentType: file.mimetype });
    const [receipt] = await db.insert(receipts).values({
      businessId: uploader.businessId,
      source: 'upload',
      status: 'pending',
      fileKey: key,
      fileName: safeName,
      mimeType: file.mimetype,
      fileSha256,
      uploadedByUploaderId: uploader.id,
      ocrJson: {
        contentKind: 'employee_upload',
        uploaderId: uploader.id,
        uploaderUsername: uploader.username,
      },
    }).returning({ id: receipts.id });

    await enqueue('receipt.extract', { receiptId: receipt.id });
    await audit(request, null, 'receipt_uploader_upload_receipt', 'receipt', receipt.id, {
      uploaderId: uploader.id,
      fileName: safeName,
    });
    return { receiptId: receipt.id, duplicate: false, processing: true };
  });
}

async function toPortalUploader(uploader: { id: string; username: string; displayName: string; businessId: string | null }) {
  const business = uploader.businessId
    ? await db.query.businesses.findFirst({ where: eq(businesses.id, uploader.businessId) })
    : null;
  return {
    id: uploader.id,
    username: uploader.username,
    displayName: uploader.displayName,
    businessId: uploader.businessId,
    businessName: business?.name ?? null,
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
