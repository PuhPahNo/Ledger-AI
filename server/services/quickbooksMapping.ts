import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { accounts, categories, qboAccounts, qboCompanies } from '../db/schema.js';
import { isBankOrCardAccountType, isExpenseAccountType } from './quickbooksNormalize.js';

/**
 * QBO chart-of-accounts → Ledger mappings:
 *  - Bank / Credit Card accounts → Ledger accounts (by last-4 vs accounts.mask), used for linking.
 *  - Expense accounts → Ledger categories (by name/sub-type similarity), used for the category signal.
 * Auto mappings only fill empty or previously-auto slots; manual choices always win.
 */

// --- Bank / card accounts ----------------------------------------------------------------------

export interface LedgerAccountLite {
  id: string;
  name: string;
  nickname?: string | null;
  mask: string | null;
  kind: string;
  businessId: string | null;
}

export interface QboAccountLite {
  name: string;
  accountType: string | null;
  acctNumLast4: string | null;
}

function kindCompatible(qboType: string | null, ledgerKind: string): boolean {
  if (qboType === 'Credit Card') return ledgerKind === 'credit' || ledgerKind === 'other';
  if (qboType === 'Bank') return ledgerKind === 'checking' || ledgerKind === 'savings' || ledgerKind === 'other';
  return false;
}

export function suggestLedgerAccounts(qbo: QboAccountLite, ledgerAccounts: LedgerAccountLite[]): LedgerAccountLite[] {
  if (!isBankOrCardAccountType(qbo.accountType) || !qbo.acctNumLast4) return [];
  return ledgerAccounts.filter((account) => {
    const mask = (account.mask ?? '').replace(/\D/g, '').slice(-4);
    return mask.length === 4 && mask === qbo.acctNumLast4 && kindCompatible(qbo.accountType, account.kind);
  });
}

// --- Expense accounts → categories -------------------------------------------------------------

const STOP_WORDS = new Set(['and', 'or', 'of', 'the', 'expense', 'expenses', 'fees', 'fee', 'other', 'general', 'misc', 'miscellaneous', 'services', 'service', 'costs', 'cost']);
const SYNONYMS: Record<string, string> = {
  advertising: 'marketing', promotional: 'marketing', promotion: 'marketing', ads: 'marketing',
  contractors: 'contract', contractor: 'contract', subcontractors: 'contract', subcontractor: 'contract', freelance: 'contract', freelancers: 'contract', '1099': 'contract',
  labour: 'labor',
  meal: 'meals', dining: 'meals', food: 'meals',
  subscriptions: 'software', subscription: 'software', saas: 'software',
  hosting: 'cloud', aws: 'cloud',
  auto: 'car', vehicle: 'car', truck: 'car', mileage: 'car',
  lease: 'rent', leases: 'rent', rental: 'rent',
  repair: 'repairs', maintenance: 'repairs',
  supply: 'supplies', materials: 'supplies',
  legal: 'professional', accounting: 'professional', bookkeeping: 'professional',
  licenses: 'taxes', license: 'taxes', tax: 'taxes',
  phone: 'utilities', internet: 'utilities', telephone: 'utilities', utility: 'utilities',
  commissions: 'commissions', bank: 'commissions', merchant: 'commissions', charges: 'commissions',
  travel: 'travel', airfare: 'travel', lodging: 'travel', hotel: 'travel',
  payroll: 'wages', salaries: 'wages', salary: 'wages',
  entertainment: 'entertainment',
  insurance: 'insurance',
  office: 'office', postage: 'office', shipping: 'office',
};

/** QBO AccountSubType → Ledger category name (seeded Schedule C categories). */
const SUBTYPE_TO_CATEGORY: Record<string, string> = {
  AdvertisingPromotional: 'Advertising & Marketing',
  Auto: 'Car & Truck',
  BankCharges: 'Commissions & Fees',
  CostOfLabor: 'Contract Labor',
  CostOfLaborCos: 'Contract Labor',
  DuesSubscriptions: 'Software',
  Entertainment: 'Entertainment',
  EntertainmentMeals: 'Meals',
  Insurance: 'Insurance',
  InterestPaid: 'Interest',
  LegalProfessionalFees: 'Legal & Professional',
  OfficeGeneralAdministrativeExpenses: 'Office Expense',
  RentOrLeaseOfBuildings: 'Rent Or Lease',
  RepairMaintenance: 'Repairs & Maintenance',
  SuppliesMaterials: 'Supplies',
  SuppliesMaterialsCogs: 'Inventory',
  TaxesPaid: 'Taxes & Licenses',
  Travel: 'Travel',
  TravelMeals: 'Meals',
  Utilities: 'Utilities',
  PayrollExpenses: 'Wages',
};

export function categoryTokens(value: string): Set<string> {
  const tokens = value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOP_WORDS.has(t))
    .map((t) => SYNONYMS[t] ?? t.replace(/s$/, ''));
  return new Set(tokens.map((t) => SYNONYMS[t] ?? t));
}

export function normalizeCategoryName(value: string): string {
  return value.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * 0..1 similarity between a QBO expense account and a Ledger category name. Sub-accounts also
 * score against their parents ("Contract Labor:Freelance Writers"), slightly discounted.
 */
export function scoreCategoryMatch(
  qbo: { name: string; accountSubType: string | null; fullyQualifiedName?: string | null },
  categoryName: string,
): number {
  const leafScore = scoreSegment({ name: qbo.name.split(':').pop() ?? qbo.name, accountSubType: qbo.accountSubType }, categoryName);
  const parents = (qbo.fullyQualifiedName ?? '').split(':').slice(0, -1).filter(Boolean);
  const parentScore = parents.reduce((best, parent) => Math.max(best, scoreSegment({ name: parent, accountSubType: null }, categoryName) * 0.9), 0);
  return Math.max(leafScore, parentScore);
}

function scoreSegment(qbo: { name: string; accountSubType: string | null }, categoryName: string): number {
  const leaf = qbo.name;
  if (normalizeCategoryName(leaf) === normalizeCategoryName(categoryName)) return 1;
  const a = categoryTokens(leaf);
  const b = categoryTokens(categoryName);
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = new Set([...a, ...b]).size;
  const jaccard = union ? intersection / union : 0;
  // Any shared distinctive token is a decent signal ("Contractors" vs "Contract Labor").
  const overlap = Math.min(a.size, b.size) ? intersection / Math.min(a.size, b.size) : 0;
  const nameScore = Math.max(jaccard, overlap * 0.8);
  const subtype = qbo.accountSubType ? SUBTYPE_TO_CATEGORY[qbo.accountSubType] : undefined;
  const subtypeScore = subtype && normalizeCategoryName(subtype) === normalizeCategoryName(categoryName) ? 0.75 : 0;
  return Math.min(1, Math.max(nameScore, subtypeScore) + (nameScore > 0 && subtypeScore > 0 ? 0.1 : 0));
}

export const CATEGORY_AUTO_MAP_THRESHOLD = 0.6;

export function suggestCategory(
  qbo: { name: string; accountSubType: string | null; fullyQualifiedName?: string | null },
  categoryOptions: Array<{ id: string; name: string }>,
): { categoryId: string; name: string; score: number } | null {
  const scored = categoryOptions
    .map((c) => ({ categoryId: c.id, name: c.name, score: scoreCategoryMatch(qbo, c.name) }))
    .filter((c) => c.score > 0)
    .sort((x, y) => y.score - x.score);
  if (!scored.length) return null;
  // A tie at the top is ambiguous.
  if (scored.length > 1 && scored[1].score === scored[0].score) return null;
  return scored[0];
}

// --- DB runners --------------------------------------------------------------------------------

export async function ledgerAccountsForBusiness(businessId: string): Promise<LedgerAccountLite[]> {
  return db
    .select({
      id: accounts.id,
      name: accounts.name,
      nickname: accounts.nickname,
      mask: accounts.mask,
      kind: accounts.kind,
      businessId: accounts.businessId,
    })
    .from(accounts)
    .where(and(eq(accounts.businessId, businessId), eq(accounts.enabled, true)));
}

export async function categoriesForBusiness(businessId: string): Promise<Array<{ id: string; name: string }>> {
  return db
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(and(eq(categories.active, true), or(isNull(categories.businessId), eq(categories.businessId, businessId))));
}

/** Fills empty / auto mapping slots from suggestions. Never overrides a manual choice. */
export async function applyAutoMappings(connectionId: string): Promise<{ accounts: number; categories: number }> {
  const company = await db.query.qboCompanies.findFirst({ where: eq(qboCompanies.connectionId, connectionId) });
  if (!company) return { accounts: 0, categories: 0 };
  const rows = await db.select().from(qboAccounts).where(and(eq(qboAccounts.connectionId, connectionId), eq(qboAccounts.deleted, false)));
  const ledgerAccounts = await ledgerAccountsForBusiness(company.businessId);
  const categoryOptions = await categoriesForBusiness(company.businessId);

  // A Ledger account already claimed manually can't be auto-assigned to another QBO account.
  const manuallyClaimed = new Set(rows.filter((r) => r.ledgerAccountMethod === 'manual' && r.ledgerAccountId).map((r) => r.ledgerAccountId!));
  let accountCount = 0;
  let categoryCount = 0;
  const claimedThisRun = new Map<string, number>();
  const accountPicks = new Map<string, string | null>();
  for (const row of rows) {
    if (!isBankOrCardAccountType(row.accountType) || row.ledgerAccountMethod === 'manual') continue;
    const matches = suggestLedgerAccounts(row, ledgerAccounts).filter((a) => !manuallyClaimed.has(a.id));
    const pick = matches.length === 1 ? matches[0].id : null;
    accountPicks.set(row.id, pick);
    if (pick) claimedThisRun.set(pick, (claimedThisRun.get(pick) ?? 0) + 1);
  }
  for (const [rowId, pick] of accountPicks) {
    const row = rows.find((r) => r.id === rowId)!;
    const finalPick = pick && claimedThisRun.get(pick) === 1 ? pick : null;
    if (finalPick === row.ledgerAccountId) continue;
    await db.update(qboAccounts).set({
      ledgerAccountId: finalPick,
      ledgerAccountMethod: finalPick ? 'auto' : null,
      updatedAt: new Date(),
    }).where(eq(qboAccounts.id, rowId));
    if (finalPick) accountCount += 1;
  }

  for (const row of rows) {
    if (!isExpenseAccountType(row.accountType) || row.ledgerCategoryMethod === 'manual') continue;
    const suggestion = suggestCategory(row, categoryOptions);
    const pick = suggestion && suggestion.score >= CATEGORY_AUTO_MAP_THRESHOLD ? suggestion : null;
    if ((pick?.categoryId ?? null) === row.ledgerCategoryId) continue;
    await db.update(qboAccounts).set({
      ledgerCategoryId: pick?.categoryId ?? null,
      ledgerCategoryMethod: pick ? 'auto' : null,
      ledgerCategoryScore: pick ? pick.score.toFixed(4) : null,
      updatedAt: new Date(),
    }).where(eq(qboAccounts.id, row.id));
    if (pick) categoryCount += 1;
  }
  return { accounts: accountCount, categories: categoryCount };
}

export async function qboAccountsByIds(connectionId: string, ids: string[]) {
  if (!ids.length) return [];
  return db.select().from(qboAccounts).where(and(eq(qboAccounts.connectionId, connectionId), inArray(qboAccounts.id, ids)));
}
