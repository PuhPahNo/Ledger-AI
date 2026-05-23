import type { FastifyInstance } from 'fastify';
import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { hashPassword } from '../auth/password.js';
import { requireUser } from '../auth/session.js';
import { db } from '../db/client.js';
import { accounts, auditLogs, businesses, categories, categoryRules, exportJobs, users } from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';
import { canSetAdminActive } from '../services/adminGuards.js';
import { audit } from '../services/audit.js';

const userPublicColumns = {
  id: users.id,
  username: users.username,
  displayName: users.displayName,
  active: users.active,
  totpEnabled: users.totpEnabled,
  lastLoginAt: users.lastLoginAt,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
};

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/overview', async (request) => {
    await requireUser(request);
    const [businessRows, categoryRows, ruleRows, accountRows, userRows, exportRows] = await Promise.all([
      db.select().from(businesses).orderBy(businesses.name),
      db.select().from(categories).orderBy(categories.name),
      db.select().from(categoryRules).orderBy(categoryRules.priority),
      db.select().from(accounts).orderBy(accounts.name),
      db.select(userPublicColumns).from(users).orderBy(users.username),
      db.select().from(exportJobs).orderBy(desc(exportJobs.createdAt)).limit(10),
    ]);
    return { businesses: businessRows, categories: categoryRows, rules: ruleRows, accounts: accountRows, users: userRows, exports: exportRows };
  });

  app.get('/admin/users', async (request) => {
    await requireUser(request);
    return db.select(userPublicColumns).from(users).orderBy(users.username);
  });

  app.post('/admin/users', async (request) => {
    const actor = await requireUser(request);
    const body = z.object({
      username: z.string().min(2),
      displayName: z.string().min(1),
      password: z.string().min(12),
    }).parse(request.body);
    const [user] = await db.insert(users).values({
      username: body.username,
      displayName: body.displayName,
      passwordHash: await hashPassword(body.password),
    }).returning();
    await audit(request, actor, 'create_user', 'user', user.id);
    return { id: user.id, username: user.username, displayName: user.displayName, active: user.active };
  });

  app.patch('/admin/users/:id', async (request) => {
    const actor = await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({
      username: z.string().min(2).optional(),
      displayName: z.string().min(1).optional(),
    }).parse(request.body);
    const [row] = await db
      .update(users)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(users.id, params.id))
      .returning(userPublicColumns);
    if (!row) notFound('User not found');
    await audit(request, actor, 'update_user', 'user', params.id, body);
    return row;
  });

  app.patch('/admin/users/:id/password', async (request) => {
    const actor = await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ password: z.string().min(12) }).parse(request.body);
    await db.update(users).set({ passwordHash: await hashPassword(body.password), updatedAt: new Date() }).where(eq(users.id, params.id));
    await audit(request, actor, 'change_user_password', 'user', params.id);
    return { ok: true };
  });

  app.patch('/admin/users/:id/active', async (request) => {
    const actor = await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ active: z.boolean() }).parse(request.body);
    const target = await db.query.users.findFirst({ where: eq(users.id, params.id) });
    if (!target) notFound('User not found');
    if (!body.active && target.active) {
      const [remaining] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(users)
        .where(sql`${users.active} = true AND ${users.id} <> ${params.id}`);
      if (!canSetAdminActive({
        targetCurrentlyActive: target.active,
        nextActive: body.active,
        remainingActiveAdmins: remaining?.count ?? 0,
      })) badRequest('Cannot deactivate the last active admin');
    }
    const [row] = await db
      .update(users)
      .set({ active: body.active, updatedAt: new Date() })
      .where(eq(users.id, params.id))
      .returning(userPublicColumns);
    await audit(request, actor, body.active ? 'activate_user' : 'deactivate_user', 'user', params.id);
    return row;
  });

  app.post('/admin/businesses', async (request) => {
    const actor = await requireUser(request);
    const body = z.object({
      key: z.string().min(2).optional(),
      name: z.string().min(1),
      short: z.string().min(1).max(4),
      color: z.string().min(1),
      hue: z.number().int().default(0),
      active: z.boolean().default(true),
    }).parse(request.body);
    const key = body.key ?? slugify(body.name);
    const [row] = await db.insert(businesses).values({ ...body, key }).returning();
    await audit(request, actor, 'create_business', 'business', row.id, { ...body, key });
    return row;
  });

  app.patch('/admin/businesses/:id', async (request) => {
    const actor = await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({
      key: z.string().min(2).optional(),
      name: z.string().min(1).optional(),
      short: z.string().min(1).max(4).optional(),
      color: z.string().optional(),
      hue: z.number().int().optional(),
      active: z.boolean().optional(),
    }).parse(request.body);
    const [row] = await db.update(businesses).set({ ...body, updatedAt: new Date() }).where(eq(businesses.id, params.id)).returning();
    await audit(request, actor, 'update_business', 'business', params.id, body);
    return row;
  });

  app.post('/admin/categories', async (request) => {
    const actor = await requireUser(request);
    const body = z.object({
      businessId: z.string().uuid().nullable().optional(),
      name: z.string().min(1),
      taxCode: z.string().optional(),
      color: z.string().optional(),
    }).parse(request.body);
    const [row] = await db.insert(categories).values(body).returning();
    await audit(request, actor, 'create_category', 'category', row.id, body);
    return row;
  });

  app.patch('/admin/categories/:id', async (request) => {
    const actor = await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({
      businessId: z.string().uuid().nullable().optional(),
      name: z.string().min(1).optional(),
      taxCode: z.string().nullable().optional(),
      color: z.string().nullable().optional(),
      active: z.boolean().optional(),
    }).parse(request.body);
    const [row] = await db
      .update(categories)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(categories.id, params.id))
      .returning();
    if (!row) notFound('Category not found');
    await audit(request, actor, 'update_category', 'category', params.id, body);
    return row;
  });

  app.post('/admin/category-rules', async (request) => {
    const actor = await requireUser(request);
    const body = z.object({
      businessId: z.string().uuid().nullable().optional(),
      categoryId: z.string().uuid(),
      matchKind: z.enum(['merchant_contains', 'merchant_exact', 'plaid_category', 'amount_range']),
      pattern: z.string().min(1),
      priority: z.number().int().default(100),
    }).parse(request.body);
    const [row] = await db.insert(categoryRules).values(body).returning();
    await audit(request, actor, 'create_category_rule', 'category_rule', row.id, body);
    return row;
  });

  app.patch('/admin/category-rules/:id', async (request) => {
    const actor = await requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({
      businessId: z.string().uuid().nullable().optional(),
      categoryId: z.string().uuid().optional(),
      matchKind: z.enum(['merchant_contains', 'merchant_exact', 'plaid_category', 'amount_range']).optional(),
      pattern: z.string().min(1).optional(),
      priority: z.number().int().optional(),
    }).parse(request.body);
    const [row] = await db
      .update(categoryRules)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(categoryRules.id, params.id))
      .returning();
    if (!row) notFound('Category rule not found');
    await audit(request, actor, 'update_category_rule', 'category_rule', params.id, body);
    return row;
  });

  app.get('/admin/audit-log', async (request) => {
    await requireUser(request);
    return db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(100);
  });
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
