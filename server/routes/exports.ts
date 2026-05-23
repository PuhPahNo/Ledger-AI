import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { requireUser } from '../auth/session.js';
import { db } from '../db/client.js';
import { exportJobs } from '../db/schema.js';
import { enqueue } from '../jobs/queue.js';
import { notFound } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import { storage } from '../services/storage.js';

export async function exportRoutes(app: FastifyInstance): Promise<void> {
  app.post('/exports', async (request) => {
    const user = await requireUser(request);
    const body = z.object({
      businessId: z.string().uuid().nullable().optional(),
      dateFrom: z.string(),
      dateTo: z.string(),
    }).parse(request.body);
    const [job] = await db.insert(exportJobs).values({
      requestedByUserId: user.id,
      businessId: body.businessId,
      dateFrom: body.dateFrom,
      dateTo: body.dateTo,
    }).returning();
    await enqueue('export.build', { exportJobId: job.id });
    await audit(request, user, 'create_export', 'export_job', job.id, body);
    return job;
  });

  app.get('/exports/:id', async (request) => {
    await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const job = await db.query.exportJobs.findFirst({ where: eq(exportJobs.id, params.id) });
    if (!job) notFound('Export job not found');
    const downloadUrl = job.fileKey ? await storage().getSignedDownloadUrl(job.fileKey, `ledger-ai-export-${job.id}.zip`) : null;
    return { ...job, downloadUrl };
  });
}
