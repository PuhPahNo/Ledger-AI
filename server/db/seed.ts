import { eq } from 'drizzle-orm';
import { hashPassword } from '../auth/password.js';
import { getEnv } from '../config/env.js';
import { db, closeDb } from './client.js';
import { businesses, categories, categoryRules, connections, transactions, users } from './schema.js';

const seedBusinesses = [
  { key: 'aurora', name: 'Aurora Studio', short: 'AS', color: '#D97757', hue: 24 },
  { key: 'meridian', name: 'Meridian Holdings', short: 'MH', color: '#2A6FDB', hue: 230 },
  { key: 'kiln', name: 'Kiln Coffee Co.', short: 'KC', color: '#1F8A5B', hue: 155 },
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
    await db.insert(categories).values({ name }).onConflictDoNothing();
  }

  await seedDemoRows();
}

async function seedDemoRows(): Promise<void> {
  const aurora = await db.query.businesses.findFirst({ where: eq(businesses.key, 'aurora') });
  const meridian = await db.query.businesses.findFirst({ where: eq(businesses.key, 'meridian') });
  const kiln = await db.query.businesses.findFirst({ where: eq(businesses.key, 'kiln') });
  const software = await db.query.categories.findFirst({ where: eq(categories.name, 'Software') });
  const meals = await db.query.categories.findFirst({ where: eq(categories.name, 'Meals') });
  const inventory = await db.query.categories.findFirst({ where: eq(categories.name, 'Inventory') });
  const cloud = await db.query.categories.findFirst({ where: eq(categories.name, 'Cloud') });
  if (!aurora || !meridian || !kiln || !software || !meals || !inventory || !cloud) return;

  const existing = await db.query.transactions.findFirst();
  if (existing) return;

  const [chase] = await db.insert(connections).values({
    kind: 'bank',
    label: 'Chase Business',
    mask: '9981',
    status: 'live',
    syncedTransactionCount: 3,
  }).returning();

  const txns = [
    { businessId: aurora.id, date: '2026-05-22', merchant: 'Figma', amountCents: -4500, categoryId: software.id, receiptStatus: 'matched' as const, sourceLabel: 'Amex 4002' },
    { businessId: meridian.id, date: '2026-05-22', merchant: 'AWS', amountCents: -128413, categoryId: cloud.id, receiptStatus: 'matched' as const, sourceLabel: 'Chase 9981' },
    { businessId: aurora.id, date: '2026-05-22', merchant: 'Sweetgreen', amountCents: -3821, categoryId: meals.id, receiptStatus: 'missing' as const, sourceLabel: 'Amex 4002', flag: 'no-receipt' },
    { businessId: kiln.id, date: '2026-05-21', merchant: 'Whole Bean Roasters', amountCents: -210400, categoryId: inventory.id, receiptStatus: 'matched' as const, sourceLabel: 'Chase 9981' },
    { businessId: aurora.id, date: '2026-05-21', merchant: 'Notion', amountCents: -1600, categoryId: software.id, receiptStatus: 'matched' as const, sourceLabel: 'Amex 4002', flag: 'dup-sub' },
    { businessId: meridian.id, date: '2026-05-21', merchant: 'Notion (annual)', amountCents: -19200, categoryId: software.id, receiptStatus: 'matched' as const, sourceLabel: 'Chase 9981', flag: 'dup-sub' },
  ];
  await db.insert(transactions).values(txns.map((txn) => ({ ...txn, accountId: null })));

  await db.insert(categoryRules).values([
    { categoryId: software.id, matchKind: 'merchant_contains', pattern: 'figma', priority: 10 },
    { categoryId: software.id, matchKind: 'merchant_contains', pattern: 'notion', priority: 10 },
    { categoryId: cloud.id, matchKind: 'merchant_contains', pattern: 'aws', priority: 10 },
    { categoryId: meals.id, matchKind: 'merchant_contains', pattern: 'sweetgreen', priority: 10 },
    { categoryId: inventory.id, businessId: kiln.id, matchKind: 'merchant_contains', pattern: 'roasters', priority: 10 },
  ]).onConflictDoNothing();

  if (chase) {
    await db.update(connections).set({ lastSyncAt: new Date() }).where(eq(connections.id, chase.id));
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
