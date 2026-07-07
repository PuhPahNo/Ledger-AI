import type { FastifyInstance } from 'fastify';
import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireUser } from '../../auth/session.js';
import { db } from '../../db/client.js';
import { tagRules, tags, transactionTags, transactions } from '../../db/schema.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { audit } from '../../services/audit.js';
import { applyTagRulesToHistory, tagsByTransactionId } from '../../services/tagging.js';
import { dateFromIso, isoDate, parseList } from './helpers.js';

const TRENDS_MAX_TAGS = 10;

const tagNameSchema = z.string().trim().min(1).max(64);
const tagColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color must be a hex string like #D97757');
const tagRuleMatchKindSchema = z.enum(['merchant_exact', 'merchant_contains']);

/**
 * Custom tags: global (cross-business) labels layered on top of categories, applied
 * manually or by merchant-matching rules (see services/tagging.ts). Backs the Tags
 * management UI and the tag trends chart.
 */
export function registerTagRoutes(app: FastifyInstance): void {
  app.get('/tags', async (request) => {
    await requireUser(request);
    const rows = await tagsWithStats();
    return { tags: rows };
  });

  app.post('/tags', async (request) => {
    const user = await requireUser(request);
    const body = z.object({
      name: tagNameSchema,
      color: tagColorSchema,
    }).parse(request.body);
    await ensureTagNameAvailable(body.name);
    const [created] = await db.insert(tags).values({ name: body.name, color: body.color }).returning();
    await audit(request, user, 'create_tag', 'tag', created.id, body);
    return { id: created.id, name: created.name, color: created.color, active: created.active, txnCount: 0, totalCents: 0 };
  });

  app.patch('/tags/:id', async (request) => {
    const user = await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({
      name: tagNameSchema.optional(),
      color: tagColorSchema.optional(),
      active: z.boolean().optional(),
    }).parse(request.body);
    if (body.name) await ensureTagNameAvailable(body.name, params.id);
    const [updated] = await db.update(tags).set(body).where(eq(tags.id, params.id)).returning();
    if (!updated) notFound('Tag not found');
    await audit(request, user, 'update_tag', 'tag', params.id, body);
    const [row] = await tagsWithStats(params.id);
    return row;
  });

  app.delete('/tags/:id', async (request, reply) => {
    const user = await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const [deleted] = await db.delete(tags).where(eq(tags.id, params.id)).returning();
    if (!deleted) notFound('Tag not found');
    await audit(request, user, 'delete_tag', 'tag', params.id, { name: deleted.name });
    return reply.status(204).send();
  });

  app.get('/tags/:id/rules', async (request) => {
    await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const tag = await db.query.tags.findFirst({ where: eq(tags.id, params.id) });
    if (!tag) notFound('Tag not found');
    const rules = await db
      .select({
        id: tagRules.id,
        tagId: tagRules.tagId,
        matchKind: tagRules.matchKind,
        pattern: tagRules.pattern,
      })
      .from(tagRules)
      .where(eq(tagRules.tagId, params.id))
      .orderBy(asc(tagRules.pattern));
    return { rules };
  });

  // Creates the rule only — new history is not retagged here; POST /tags/:id/apply does
  // that explicitly so the UI can show what a rule would change before committing.
  app.post('/tags/:id/rules', async (request) => {
    const user = await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({
      matchKind: tagRuleMatchKindSchema,
      pattern: z.string().trim().min(1).max(200),
    }).parse(request.body);
    const tag = await db.query.tags.findFirst({ where: eq(tags.id, params.id) });
    if (!tag) notFound('Tag not found');
    const existing = await db.query.tagRules.findFirst({
      where: and(
        eq(tagRules.tagId, params.id),
        eq(tagRules.matchKind, body.matchKind),
        eq(tagRules.pattern, body.pattern),
      ),
    });
    if (existing) conflict('An identical rule already exists for this tag');
    const [created] = await db.insert(tagRules).values({
      tagId: params.id,
      matchKind: body.matchKind,
      pattern: body.pattern,
    }).returning();
    await audit(request, user, 'create_tag_rule', 'tag_rule', created.id, { tagId: params.id, ...body });
    return { id: created.id, tagId: created.tagId, matchKind: created.matchKind, pattern: created.pattern };
  });

  app.delete('/tag-rules/:id', async (request, reply) => {
    const user = await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const [deleted] = await db.delete(tagRules).where(eq(tagRules.id, params.id)).returning();
    if (!deleted) notFound('Tag rule not found');
    await audit(request, user, 'delete_tag_rule', 'tag_rule', params.id, {
      tagId: deleted.tagId,
      matchKind: deleted.matchKind,
      pattern: deleted.pattern,
    });
    return reply.status(204).send();
  });

  // Retag history with this tag's rules. Only inserts missing 'auto' links — manual
  // tags are never touched, existing links never duplicate.
  app.post('/tags/:id/apply', async (request) => {
    const user = await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const tag = await db.query.tags.findFirst({ where: eq(tags.id, params.id) });
    if (!tag) notFound('Tag not found');
    const tagged = await applyTagRulesToHistory(params.id);
    await audit(request, user, 'apply_tag_rules', 'tag', params.id, { tagged });
    return { tagged };
  });

  // Monthly spend per tag for the trends chart. totalCents is outflow spend —
  // sum(abs(amount_cents)) where amount_cents < 0 — matching how /transactions/rollup
  // computes outflowCents. Months without data are zero-filled.
  app.get('/tags/trends', async (request) => {
    await requireUser(request);
    const query = z.object({
      tags: z.string().optional(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }).parse(request.query);

    const requestedTagIds = parseList(query.tags);
    if (requestedTagIds.length > TRENDS_MAX_TAGS) {
      badRequest(`At most ${TRENDS_MAX_TAGS} tags per trends request`);
    }
    const selectedTags = requestedTagIds.length
      ? await db.select().from(tags).where(inArray(tags.id, requestedTagIds)).orderBy(asc(tags.name))
      : await db.select().from(tags).where(eq(tags.active, true)).orderBy(asc(tags.name));
    if (!requestedTagIds.length && selectedTags.length > TRENDS_MAX_TAGS) {
      badRequest(`More than ${TRENDS_MAX_TAGS} active tags — pass an explicit tags=<id,id> list`);
    }
    if (selectedTags.length === 0) return { series: [] };

    const { from, to } = trendsWindow(query.from, query.to);
    const months = monthKeys(from, to);
    const tagIds = selectedTags.map((tag) => tag.id);
    const monthExpr = sql<string>`to_char(${transactions.date}, 'YYYY-MM')`;
    const rows = await db
      .select({
        tagId: transactionTags.tagId,
        month: monthExpr,
        totalCents: sql<number>`coalesce(abs(sum(${transactions.amountCents})), 0)::int`,
        count: sql<number>`count(${transactions.id})::int`,
      })
      .from(transactionTags)
      .innerJoin(transactions, eq(transactions.id, transactionTags.transactionId))
      .where(and(
        inArray(transactionTags.tagId, tagIds),
        gte(transactions.date, from),
        lte(transactions.date, to),
        sql`${transactions.amountCents} < 0`,
      ))
      .groupBy(transactionTags.tagId, monthExpr);

    const byTagMonth = new Map(rows.map((row) => [`${row.tagId}:${row.month}`, row]));
    return {
      series: selectedTags.map((tag) => ({
        tagId: tag.id,
        name: tag.name,
        color: tag.color,
        points: months.map((month) => {
          const row = byTagMonth.get(`${tag.id}:${month}`);
          return {
            month,
            totalCents: Number(row?.totalCents ?? 0),
            count: Number(row?.count ?? 0),
          };
        }),
      })),
    };
  });

  // Manually tag a transaction. Re-tagging an existing 'auto' link upgrades it to
  // 'manual' so rule cleanups can't strip a tag the user explicitly confirmed.
  app.post('/transactions/:id/tags', async (request) => {
    const user = await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ tagId: z.string().uuid() }).parse(request.body);
    const transaction = await db.query.transactions.findFirst({ where: eq(transactions.id, params.id) });
    if (!transaction) notFound('Transaction not found');
    const tag = await db.query.tags.findFirst({ where: eq(tags.id, body.tagId) });
    if (!tag) notFound('Tag not found');

    await db
      .insert(transactionTags)
      .values({ transactionId: params.id, tagId: body.tagId, source: 'manual' })
      .onConflictDoUpdate({
        target: [transactionTags.transactionId, transactionTags.tagId],
        set: { source: 'manual' },
      });
    await audit(request, user, 'tag_transaction', 'transaction', params.id, { tagId: body.tagId, tagName: tag.name });

    const tagsById = await tagsByTransactionId([params.id]);
    return { tags: tagsById.get(params.id) ?? [] };
  });

  // Removes the tag from the transaction regardless of source — an explicit user
  // removal outranks both rules and prior manual adds.
  app.delete('/transactions/:id/tags/:tagId', async (request, reply) => {
    const user = await requireUser(request);
    const params = z.object({
      id: z.string().uuid(),
      tagId: z.string().uuid(),
    }).parse(request.params);
    const [deleted] = await db
      .delete(transactionTags)
      .where(and(
        eq(transactionTags.transactionId, params.id),
        eq(transactionTags.tagId, params.tagId),
      ))
      .returning();
    if (!deleted) notFound('Transaction tag not found');
    await audit(request, user, 'untag_transaction', 'transaction', params.id, { tagId: params.tagId });
    return reply.status(204).send();
  });
}

/**
 * Tags with usage stats in one grouped query. totalCents is outflow spend —
 * sum(abs(amount_cents)) where amount_cents < 0 — matching /transactions/rollup's
 * outflowCents convention (inflows count toward txnCount but not totalCents).
 */
async function tagsWithStats(tagId?: string) {
  const rows = await db
    .select({
      id: tags.id,
      name: tags.name,
      color: tags.color,
      active: tags.active,
      txnCount: sql<number>`count(${transactionTags.transactionId})::int`,
      totalCents: sql<number>`coalesce(abs(sum(CASE WHEN ${transactions.amountCents} < 0 THEN ${transactions.amountCents} ELSE 0 END)), 0)::int`,
    })
    .from(tags)
    .leftJoin(transactionTags, eq(transactionTags.tagId, tags.id))
    .leftJoin(transactions, eq(transactions.id, transactionTags.transactionId))
    .where(tagId ? eq(tags.id, tagId) : sql`true`)
    .groupBy(tags.id)
    .orderBy(asc(tags.name));
  return rows.map((row) => ({
    ...row,
    txnCount: Number(row.txnCount ?? 0),
    totalCents: Number(row.totalCents ?? 0),
  }));
}

/** Tag names are case-insensitively unique (mirrors the lower(name) unique index). */
async function ensureTagNameAvailable(name: string, excludeId?: string): Promise<void> {
  const existing = await db.query.tags.findFirst({
    where: sql`lower(${tags.name}) = lower(${name})`,
  });
  if (existing && existing.id !== excludeId) conflict(`A tag named "${existing.name}" already exists`);
}

/** Default trends range: the trailing 12 calendar months, ending this month. */
function trendsWindow(from?: string, to?: string): { from: string; to: string } {
  if (from && to) {
    if (from > to) badRequest('from must be on or before to');
    return { from, to };
  }
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  return {
    from: from ?? isoDate(start),
    to: to ?? isoDate(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
  };
}

/** Every YYYY-MM between from and to inclusive, for zero-filling. */
function monthKeys(from: string, to: string): string[] {
  const end = dateFromIso(to);
  const cursor = new Date(dateFromIso(from).getFullYear(), dateFromIso(from).getMonth(), 1);
  const months: string[] = [];
  while (cursor <= end) {
    months.push(isoDate(cursor).slice(0, 7));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return months;
}
