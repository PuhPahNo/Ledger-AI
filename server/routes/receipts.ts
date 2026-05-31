import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import { and, desc, eq, getTableColumns, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireUser } from '../auth/session.js';
import { db } from '../db/client.js';
import { businesses, receiptMatches, receiptUploaders, receipts, users } from '../db/schema.js';
import { enqueue } from '../jobs/queue.js';
import { sha256Buffer } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import { matchReceipt } from '../services/matching.js';
import { storage } from '../services/storage.js';
import { toApiReceipt } from './mappers.js';

export async function receiptRoutes(app: FastifyInstance): Promise<void> {
  app.get('/receipts', async (request) => {
    await requireUser(request);
    const query = z.object({
      status: z.enum(['matched', 'pending', 'missing', 'n/a', 'waived']).optional(),
      unmatched: z.enum(['true', 'false']).optional().transform((value) => value === 'true'),
      biz: z.string().optional(),
      source: z.enum(['upload', 'gmail', 'all']).optional().default('all'),
      q: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }).parse(request.query);

    const rows = await db
      .select({
        ...getTableColumns(receipts),
        businessKey: businesses.key,
        businessName: businesses.name,
        uploadedByUserName: users.displayName,
        uploadedByUploaderName: receiptUploaders.displayName,
      })
      .from(receipts)
      .leftJoin(businesses, eq(receipts.businessId, businesses.id))
      .leftJoin(users, eq(receipts.uploadedByUserId, users.id))
      .leftJoin(receiptUploaders, eq(receipts.uploadedByUploaderId, receiptUploaders.id))
      .where(and(
        query.status ? eq(receipts.status, query.status) : sql`true`,
        query.unmatched ? isNull(receipts.transactionId) : sql`true`,
        query.biz && query.biz !== 'all' ? eq(businesses.key, query.biz) : sql`true`,
        query.source !== 'all' ? eq(receipts.source, query.source) : sql`true`,
        query.q ? sql`(
          ${receipts.merchant} ILIKE ${`%${query.q}%`}
          OR ${receipts.fileName} ILIKE ${`%${query.q}%`}
          OR ${businesses.name} ILIKE ${`%${query.q}%`}
        )` : sql`true`,
      ))
      .orderBy(desc(receipts.createdAt))
      .limit(query.limit);

    return rows.map((row) => toApiReceipt(row));
  });

  app.get('/receipts/:id', async (request) => {
    await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const receipt = await receiptWithPresentation(params.id);
    if (!receipt) notFound('Receipt not found');
    const downloadUrl = receipt.fileKey ? await storage().getSignedDownloadUrl(receipt.fileKey, receipt.fileName ?? undefined) : null;
    return { ...toApiReceipt(receipt), downloadUrl };
  });

  app.patch('/receipts/:id', async (request) => {
    const user = await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({
      merchant: z.string().trim().min(1).max(160).nullable().optional(),
      totalCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
      receiptDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    }).parse(request.body);

    const [updated] = await db
      .update(receipts)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(receipts.id, params.id))
      .returning({ id: receipts.id });
    if (!updated) notFound('Receipt not found');

    await audit(request, user, 'update_receipt', 'receipt', params.id, body);
    const receipt = await receiptWithPresentation(params.id);
    if (!receipt) notFound('Receipt not found');
    return toApiReceipt(receipt);
  });

  app.get('/receipts/:id/file', async (request, reply) => {
    await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = z.object({
      download: z.enum(['true', 'false']).optional().transform((value) => value === 'true'),
    }).parse(request.query);
    const receipt = await db.query.receipts.findFirst({ where: eq(receipts.id, params.id) });
    if (!receipt) notFound('Receipt not found');
    if (!receipt.fileKey) notFound('Receipt file not found');

    const fileName = receipt.fileName ?? 'receipt';
    const mimeType = effectiveReceiptMimeType(receipt.mimeType, fileName);
    reply
      .header('Content-Type', textMimeTypeWithCharset(mimeType))
      .header('Content-Disposition', `${query.download ? 'attachment' : 'inline'}; filename="${headerSafeFileName(fileName)}"`)
      .header('X-Content-Type-Options', 'nosniff');

    return reply.send(await storage().getStream(receipt.fileKey));
  });

  app.post('/receipts', async (request) => {
    const user = await requireUser(request);
    const file = await request.file();
    if (!file) badRequest('Missing receipt file');
    const chunks: Buffer[] = [];
    for await (const chunk of file.file) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);
    const fileSha256 = sha256Buffer(buffer);
    const safeName = sanitizeFileName(file.filename);
    const rawBusinessId = (file.fields as Record<string, { value?: unknown }>).businessId?.value;
    const businessId = typeof rawBusinessId === 'string' && rawBusinessId.length > 0
      ? z.string().uuid().parse(rawBusinessId)
      : undefined;
    if (businessId) {
      const business = await db.query.businesses.findFirst({ where: eq(businesses.id, businessId) });
      if (!business) notFound('Business not found');
    }
    const key = `receipts/upload/${new Date().toISOString().slice(0, 10)}/${cryptoRandom()}-${safeName}`;
    await storage().put({ key, body: buffer, contentType: file.mimetype });
    const [receipt] = await db.insert(receipts).values({
      businessId,
      source: 'upload',
      status: 'pending',
      fileKey: key,
      fileName: safeName,
      mimeType: file.mimetype,
      fileSha256,
      uploadedByUserId: user.id,
      ocrJson: {},
    }).returning();
    await enqueue('receipt.extract', { receiptId: receipt.id });
    await audit(request, user, 'upload_receipt', 'receipt', receipt.id, { fileName: safeName });
    return { receiptId: receipt.id, processing: true };
  });

  app.post('/receipts/:id/match', async (request) => {
    await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await matchReceipt(params.id);
    return { matched: result };
  });

  app.post('/receipts/:id/dismiss', async (request) => {
    const user = await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const [receipt] = await db
      .update(receipts)
      .set({ status: 'n/a', updatedAt: new Date() })
      .where(eq(receipts.id, params.id))
      .returning();
    if (!receipt) notFound('Receipt not found');
    await db
      .update(receiptMatches)
      .set({ status: 'rejected', decidedAt: new Date() })
      .where(eq(receiptMatches.receiptId, params.id));
    await audit(request, user, 'dismiss_receipt', 'receipt', params.id);
    return { ok: true };
  });
}

async function receiptWithPresentation(id: string) {
  const [receipt] = await db
    .select({
      ...getTableColumns(receipts),
      businessKey: businesses.key,
      businessName: businesses.name,
      uploadedByUserName: users.displayName,
      uploadedByUploaderName: receiptUploaders.displayName,
    })
    .from(receipts)
    .leftJoin(businesses, eq(receipts.businessId, businesses.id))
    .leftJoin(users, eq(receipts.uploadedByUserId, users.id))
    .leftJoin(receiptUploaders, eq(receipts.uploadedByUploaderId, receiptUploaders.id))
    .where(eq(receipts.id, id))
    .limit(1);
  return receipt;
}

function sanitizeFileName(fileName: string): string {
  const parsed = path.parse(fileName);
  const base = parsed.name.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 80) || 'receipt';
  const ext = parsed.ext.replace(/[^a-z0-9.]+/gi, '').slice(0, 12);
  return `${base}${ext}`;
}

function effectiveReceiptMimeType(mimeType: string | null, fileName: string): string {
  if (mimeType && mimeType !== 'application/octet-stream') return mimeType;
  if (/\.pdf$/i.test(fileName)) return 'application/pdf';
  if (/\.png$/i.test(fileName)) return 'image/png';
  if (/\.jpe?g$/i.test(fileName)) return 'image/jpeg';
  if (/\.gif$/i.test(fileName)) return 'image/gif';
  if (/\.webp$/i.test(fileName)) return 'image/webp';
  if (/\.html?$/i.test(fileName)) return 'text/html';
  if (/\.(txt|md|markdown|csv|tsv|json|log)$/i.test(fileName)) return 'text/plain';
  return mimeType || 'application/octet-stream';
}

function textMimeTypeWithCharset(mimeType: string): string {
  return mimeType.startsWith('text/') ? `${mimeType}; charset=utf-8` : mimeType;
}

function headerSafeFileName(fileName: string): string {
  return fileName.replace(/["\r\n\\]+/g, '-').slice(0, 120) || 'receipt';
}

function cryptoRandom(): string {
  return Math.random().toString(36).slice(2, 10);
}
