import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { requireUser } from '../auth/session.js';
import { db } from '../db/client.js';
import { receipts } from '../db/schema.js';
import { enqueue } from '../jobs/queue.js';
import { badRequest, notFound } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import { matchReceipt } from '../services/matching.js';
import { storage } from '../services/storage.js';

export async function receiptRoutes(app: FastifyInstance): Promise<void> {
  app.get('/receipts', async (request) => {
    await requireUser(request);
    return db.select().from(receipts);
  });

  app.get('/receipts/:id', async (request) => {
    await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const receipt = await db.query.receipts.findFirst({ where: eq(receipts.id, params.id) });
    if (!receipt) notFound('Receipt not found');
    const downloadUrl = receipt.fileKey ? await storage().getSignedDownloadUrl(receipt.fileKey, receipt.fileName ?? undefined) : null;
    return { ...receipt, downloadUrl };
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
    const safeName = sanitizeFileName(file.filename);
    const key = `receipts/upload/${new Date().toISOString().slice(0, 10)}/${cryptoRandom()}-${safeName}`;
    await storage().put({ key, body: buffer, contentType: file.mimetype });
    const [receipt] = await db.insert(receipts).values({
      source: 'upload',
      status: 'pending',
      fileKey: key,
      fileName: safeName,
      mimeType: file.mimetype,
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
