import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../../auth/session.js';
import { badRequest } from '../../lib/errors.js';
import { audit } from '../../services/audit.js';
import { setSetting } from '../../services/appSettings.js';
import { buildCloseReadiness, closeMonthBounds, closeMonthForRange, closeSignoffKey } from './closeReadiness.js';
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
      from: z.string().optional(),
      to: z.string().optional(),
      month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
      biz: z.string().optional(),
      accounts: z.array(z.string()).optional().default([]),
    }).parse(request.body);
    const month = body.month ?? (body.from && body.to ? closeMonthForRange(body.from, body.to) : null);
    if (!month) badRequest('Month close covers one calendar month — pick a range inside a single month.');
    // Sign-off always covers the whole calendar month, regardless of the viewed range.
    const bounds = closeMonthBounds(month);
    const readiness = await buildCloseReadiness({
      from: bounds.from,
      to: bounds.to,
      biz: body.biz,
      accountIds: [],
    });
    if (readiness.signedOff) badRequest(`${month} is already signed off.`);
    if (!readiness.canSignOff) badRequest('Month still has close blockers.');
    const signedOffAt = new Date().toISOString();
    await setSetting(closeSignoffKey(readiness.biz, month), JSON.stringify({
      signedOffAt,
      signedOffByUserId: user.id,
      month,
    }));
    await audit(request, user, 'sign_off_close_period', 'close_period', `${readiness.biz}:${month}`, {
      month,
      biz: readiness.biz,
    });
    // Answer with the caller's view (their range), now reflecting the sign-off.
    return buildCloseReadiness({
      from: body.from ?? bounds.from,
      to: body.to ?? bounds.to,
      biz: body.biz,
      accountIds: body.accounts,
    });
  });
}
