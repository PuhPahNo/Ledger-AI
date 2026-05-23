import { and, eq, isNull } from 'drizzle-orm';
import { hashPassword } from '../auth/password.js';
import { getEnv } from '../config/env.js';
import { db, closeDb } from './client.js';
import { businesses, categories, categoryRules, users } from './schema.js';

const seedBusinesses = [
  { key: 'draft-sharks', name: 'Draft Sharks', short: 'DS', color: '#D97757', hue: 24 },
  { key: 'pointsnav', name: 'PointsNav', short: 'PN', color: '#2A6FDB', hue: 230 },
  { key: 'womens-net', name: 'Womens Net', short: 'WN', color: '#1F8A5B', hue: 155 },
];

const seedCategories = [
  'Software',
  'Cloud',
  'Travel',
  'Inventory',
  'Meals',
  'Supplies',
  'Utilities',
  'Equipment',
  'Revenue',
];

export async function seed(): Promise<void> {
  const env = getEnv();

  const existingAdmin = await db.query.users.findFirst({
    where: eq(users.username, env.LEDGER_ADMIN_USERNAME),
  });
  if (!existingAdmin) {
    await db.insert(users).values({
      username: env.LEDGER_ADMIN_USERNAME,
      displayName: 'Ledger Admin',
      passwordHash: await hashPassword(env.LEDGER_ADMIN_PASSWORD),
    });
  }

  for (const business of seedBusinesses) {
    await db.insert(businesses).values(business).onConflictDoNothing({ target: businesses.key });
  }

  for (const name of seedCategories) {
    const existing = await db.query.categories.findFirst({
      where: and(eq(categories.name, name), isNull(categories.businessId)),
    });
    if (!existing) await db.insert(categories).values({ name });
  }

  const software = await db.query.categories.findFirst({ where: eq(categories.name, 'Software') });
  const meals = await db.query.categories.findFirst({ where: eq(categories.name, 'Meals') });
  const inventory = await db.query.categories.findFirst({ where: eq(categories.name, 'Inventory') });
  const cloud = await db.query.categories.findFirst({ where: eq(categories.name, 'Cloud') });
  const womensNet = await db.query.businesses.findFirst({ where: eq(businesses.key, 'womens-net') });
  if (!software || !meals || !inventory || !cloud) return;

  const rules = [
    { categoryId: software.id, matchKind: 'merchant_contains', pattern: 'figma', priority: 10 },
    { categoryId: software.id, matchKind: 'merchant_contains', pattern: 'notion', priority: 10 },
    { categoryId: cloud.id, matchKind: 'merchant_contains', pattern: 'aws', priority: 10 },
    { categoryId: meals.id, matchKind: 'merchant_contains', pattern: 'sweetgreen', priority: 10 },
    ...(womensNet ? [{ categoryId: inventory.id, businessId: womensNet.id, matchKind: 'merchant_contains' as const, pattern: 'equipment', priority: 10 }] : []),
  ];
  for (const rule of rules) {
    const existing = await db.query.categoryRules.findFirst({
      where: and(
        eq(categoryRules.categoryId, rule.categoryId),
        eq(categoryRules.matchKind, rule.matchKind),
        eq(categoryRules.pattern, rule.pattern),
      ),
    });
    if (!existing) await db.insert(categoryRules).values(rule);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seed()
    .then(() => closeDb())
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
