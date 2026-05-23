import type { FastifyRequest } from 'fastify';
import { db } from '../db/client.js';
import { auditLogs } from '../db/schema.js';
import type { AuthedUser } from '../auth/session.js';

export async function audit(
  request: FastifyRequest,
  user: AuthedUser | null,
  action: string,
  entityType: string,
  entityId?: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(auditLogs).values({
    userId: user?.id,
    action,
    entityType,
    entityId,
    metadata,
    ip: request.ip,
  });
}
