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
  { name: 'Advertising & Marketing', taxCode: 'schedule_c_line_8', color: '#ff8b6b' },
  { name: 'Car & Truck', taxCode: 'schedule_c_line_9', color: '#9fc6e8' },
  { name: 'Commissions & Fees', taxCode: 'schedule_c_line_10', color: '#caa6f0' },
  { name: 'Contract Labor', taxCode: 'schedule_c_line_11', color: '#abc89a' },
  { name: 'Depreciation & Section 179', taxCode: 'schedule_c_line_13', color: '#ecd95a' },
  { name: 'Employee Benefits', taxCode: 'schedule_c_line_14', color: '#f1b6c5' },
  { name: 'Insurance', taxCode: 'schedule_c_line_15', color: '#9fc6e8' },
  { name: 'Interest', taxCode: 'schedule_c_line_16', color: '#3e2a3e' },
  { name: 'Legal & Professional', taxCode: 'schedule_c_line_17', color: '#ff8b6b' },
  { name: 'Office Expense', taxCode: 'schedule_c_line_18', color: '#f7f3e6' },
  { name: 'Rent Or Lease', taxCode: 'schedule_c_line_20', color: '#abc89a' },
  { name: 'Repairs & Maintenance', taxCode: 'schedule_c_line_21', color: '#caa6f0' },
  { name: 'Supplies', taxCode: 'schedule_c_line_22', color: '#caa6f0' },
  { name: 'Taxes & Licenses', taxCode: 'schedule_c_line_23', color: '#ecd95a' },
  { name: 'Travel', taxCode: 'schedule_c_line_24a', color: '#3e2a3e' },
  { name: 'Meals', taxCode: 'schedule_c_line_24b', color: '#f1b6c5' },
  { name: 'Utilities', taxCode: 'schedule_c_line_25', color: '#9fc6e8' },
  { name: 'Wages', taxCode: 'schedule_c_line_26', color: '#abc89a' },
  { name: 'Inventory', taxCode: 'cogs_inventory', color: '#abc89a' },
  { name: 'Software', taxCode: 'other_expense_software', color: '#ff8b6b' },
  { name: 'Cloud', taxCode: 'other_expense_software', color: '#9fc6e8' },
  { name: 'Equipment', taxCode: 'schedule_c_line_13_review', color: '#ecd95a' },
  { name: 'Entertainment', taxCode: 'non_deductible_review', color: '#3e2a3e' },
  { name: 'Transfers', taxCode: 'exclude_transfer', color: '#ffffff' },
  { name: 'Revenue', taxCode: 'income', color: '#ffffff' },
  { name: 'Uncategorized', taxCode: 'review_required', color: '#ffffff' },
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

  for (const category of seedCategories) {
    const existing = await db.query.categories.findFirst({
      where: and(eq(categories.name, category.name), isNull(categories.businessId)),
    });
    if (!existing) await db.insert(categories).values(category);
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
    { categoryId: meals.id, matchKind: 'merchant_contains', pattern: 'junction', priority: 2 },
    { categoryId: meals.id, matchKind: 'merchant_contains', pattern: 'starbucks', priority: 2 },
    { categoryId: meals.id, matchKind: 'merchant_contains', pattern: 'dunkin', priority: 2 },
    { categoryId: meals.id, matchKind: 'merchant_contains', pattern: 'sweetgreen', priority: 2 },
    { categoryId: meals.id, matchKind: 'merchant_contains', pattern: 'coffee', priority: 3 },
    { categoryId: meals.id, matchKind: 'merchant_contains', pattern: 'cafe', priority: 3 },
    { categoryId: meals.id, matchKind: 'merchant_contains', pattern: 'restaurant', priority: 3 },
    { categoryId: meals.id, matchKind: 'merchant_contains', pattern: 'doordash', priority: 3 },
    { categoryId: meals.id, matchKind: 'merchant_contains', pattern: 'uber eats', priority: 3 },
    { categoryId: meals.id, matchKind: 'merchant_contains', pattern: 'grubhub', priority: 3 },
    { categoryId: meals.id, matchKind: 'plaid_category', pattern: 'food and drink', priority: 2 },
    { categoryId: meals.id, matchKind: 'plaid_category', pattern: 'restaurant', priority: 2 },
    { categoryId: meals.id, matchKind: 'plaid_category', pattern: 'coffee', priority: 2 },
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
