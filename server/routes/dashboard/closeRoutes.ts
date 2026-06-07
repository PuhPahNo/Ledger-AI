import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../../auth/session.js';
import { badRequest } from '../../lib/errors.js';
import { audit } from '../../services/audit.js';
import { setSetting } from '../../services/appSettings.js';
import { buildCloseReadiness, closeSignoffKey } from './closeReadiness.js';
import { dateFromIso, isoDate, parseAccountIds } from './helpers.js';

export function registerCloseRoutes(app: FastifyInstance): void {
  app.get('/close-readiness', async (request) => {
    await requireUser(request);
    const query = z.object({
      from: z.string().optional(),
      to: z.string().optional(),
      biz: z.string().optional(),
      accounts: z.string().optional(),
    }).parse(request.query);
    const to = query.to ?? isoDate(new Date());
    const from = query.from ?? isoDate(new Date(dateFromIso(to).getFullYear(), dateFromIso(to).getMonth(), 1));
    const accountIds = parseAccountIds(query.accounts);
    return buildCloseReadiness({ from, to, biz: query.biz, accountIds });
  });

  app.post('/close-readiness/sign-off', async (request) => {
    const user = await requireUser(request);
    const body = z.object({
      from: z.string(),
      to: z.string(),
      biz: z.string().optional(),
      accounts: z.array(z.string()).optional().default([]),
    }).parse(request.body);
    const readiness = await buildCloseReadiness({
      from: body.from,
      to: body.to,
      biz: body.biz,
      accountIds: body.accounts,
    });
    if (!readiness.canSignOff) badRequest('Period still has close blockers.');
    const signedOffAt = new Date().toISOString();
    await setSetting(closeSignoffKey(readiness.biz, readiness.from, readiness.to), JSON.stringify({
      signedOffAt,
      signedOffByUserId: user.id,
    }));
    await audit(request, user, 'sign_off_close_period', 'close_period', `${readiness.biz}:${readiness.from}:${readiness.to}`, {
      from: readiness.from,
      to: readiness.to,
      biz: readiness.biz,
    });
    return {
      ...readiness,
      signedOff: true,
      signedOffAt,
      canSignOff: false,
      items: readiness.items.filter((item) => item.id !== 'sign-off'),
    };
  });
}
