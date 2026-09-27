import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  qboAccounts,
  qboCompanies,
  qboTransactionLinks,
  qboTransactions,
  transactions,
  type QboTransactionLeg,
} from '../db/schema.js';

/**
 * Links QBO payment-type transactions (their bank/card "legs") to Ledger (Plaid) transactions.
 * Rules: same mapped account, exact sign-aware amount, date inside the window (±4 days; checks
 * may clear up to 10 days late), and a single unambiguous candidate. Anything ambiguous is left
 * for a manual link.
 */

export interface LinkLeg {
  qboTransactionId: string;
  leg: QboTransactionLeg['leg'];
  ledgerAccountId: string;
  amountCents: number;
  txnDate: string;
  paymentMethod: string | null;
  docNumber: string | null;
}

export interface LinkCandidateTxn {
  id: string;
  accountId: string | null;
  amountCents: number;
  date: string;
  checkNumber: string | null;
}

export interface PlannedLink {
  qboTransactionId: string;
  leg: QboTransactionLeg['leg'];
  transactionId: string;
  confidence: number;
  reasons: Record<string, unknown>;
}

export const LINK_WINDOW_DAYS = 4;
export const CHECK_CLEARING_DAYS = 10;

/** Days the bank-side date may fall before / after the QBO date. */
export function linkWindow(paymentMethod: string | null): { before: number; after: number } {
  return paymentMethod === 'check'
    ? { before: LINK_WINDOW_DAYS, after: CHECK_CLEARING_DAYS }
    : { before: LINK_WINDOW_DAYS, after: LINK_WINDOW_DAYS };
}

export function dayDiff(from: string, to: string): number {
  const a = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)));
  const b = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)));
  return Math.round((b - a) / 86_400_000);
}

export function linkConfidence(daysApart: number, checkNumberMatch: boolean): number {
  if (checkNumberMatch) return 0.99;
  return Math.max(0.8, 0.99 - 0.02 * Math.abs(daysApart));
}

export function legKey(qboTransactionId: string, leg: string): string {
  return `${qboTransactionId}|${leg}`;
}

export function pairKey(qboTransactionId: string, leg: string, transactionId: string): string {
  return `${qboTransactionId}|${leg}|${transactionId}`;
}

function normalizeCheckNumber(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '').replace(/^0+/, '');
  return digits || null;
}

export function candidatesForLeg(
  leg: LinkLeg,
  txns: LinkCandidateTxn[],
  exclude: { linkedTransactionIds: Set<string>; rejectedPairs: Set<string> },
): Array<LinkCandidateTxn & { daysApart: number }> {
  const window = linkWindow(leg.paymentMethod);
  const out: Array<LinkCandidateTxn & { daysApart: number }> = [];
  for (const txn of txns) {
    if (txn.accountId !== leg.ledgerAccountId) continue;
    if (txn.amountCents !== leg.amountCents) continue;
    if (exclude.linkedTransactionIds.has(txn.id)) continue;
    if (exclude.rejectedPairs.has(pairKey(leg.qboTransactionId, leg.leg, txn.id))) continue;
    const daysApart = dayDiff(leg.txnDate, txn.date);
    if (daysApart < -window.before || daysApart > window.after) continue;
    out.push({ ...txn, daysApart });
  }
  return out.sort((a, b) => Math.abs(a.daysApart) - Math.abs(b.daysApart));
}

/**
 * Plans auto links. A leg links only when it has exactly one candidate (or exactly one whose
 * check number equals the QBO check/doc number). If two legs would claim the same Ledger
 * transaction, neither links — the user decides.
 */
export function planAutoLinks(
  legs: LinkLeg[],
  txns: LinkCandidateTxn[],
  existing: { linkedLegs: Set<string>; linkedTransactionIds: Set<string>; rejectedPairs: Set<string> },
): PlannedLink[] {
  const picks: PlannedLink[] = [];
  for (const leg of legs) {
    if (existing.linkedLegs.has(legKey(leg.qboTransactionId, leg.leg))) continue;
    const candidates = candidatesForLeg(leg, txns, existing);
    if (!candidates.length) continue;

    let chosen: (typeof candidates)[number] | null = null;
    let checkMatch = false;
    const docCheck = leg.paymentMethod === 'check' ? normalizeCheckNumber(leg.docNumber) : null;
    if (docCheck) {
      const byCheck = candidates.filter((c) => normalizeCheckNumber(c.checkNumber) === docCheck);
      if (byCheck.length === 1) {
        chosen = byCheck[0];
        checkMatch = true;
      }
    }
    if (!chosen && candidates.length === 1) chosen = candidates[0];
    if (!chosen) continue;

    picks.push({
      qboTransactionId: leg.qboTransactionId,
      leg: leg.leg,
      transactionId: chosen.id,
      confidence: linkConfidence(chosen.daysApart, checkMatch),
      reasons: {
        exactAmount: true,
        daysApart: chosen.daysApart,
        sameAccount: true,
        ...(checkMatch ? { checkNumber: true } : {}),
        candidateCount: candidates.length,
      },
    });
  }

  const claims = new Map<string, number>();
  for (const pick of picks) claims.set(pick.transactionId, (claims.get(pick.transactionId) ?? 0) + 1);
  return picks.filter((pick) => claims.get(pick.transactionId) === 1);
}

/** An auto link whose QBO side changed (deleted, new amount/account) no longer holds. */
export function autoLinkIsStale(
  leg: QboTransactionLeg | undefined,
  deleted: boolean,
  ledgerAccountId: string | null,
  txn: { accountId: string | null; amountCents: number } | undefined,
): boolean {
  if (deleted || !leg || !ledgerAccountId || !txn) return true;
  return txn.accountId !== ledgerAccountId || txn.amountCents !== leg.amountCents;
}

function checkNumberFromRaw(raw: Record<string, unknown> | null | undefined): string | null {
  const value = raw?.check_number;
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

export interface AutoLinkRunResult {
  created: PlannedLink[];
  removedStale: number;
}

/** Re-evaluates auto links for one QuickBooks connection. Manual links are never touched. */
export async function runAutoLinking(connectionId: string): Promise<AutoLinkRunResult> {
  const company = await db.query.qboCompanies.findFirst({ where: eq(qboCompanies.connectionId, connectionId) });
  if (!company) return { created: [], removedStale: 0 };

  const accountRows = await db
    .select({ qboId: qboAccounts.qboId, ledgerAccountId: qboAccounts.ledgerAccountId })
    .from(qboAccounts)
    .where(and(eq(qboAccounts.connectionId, connectionId), eq(qboAccounts.deleted, false)));
  const ledgerAccountByQbo = new Map(accountRows.filter((r) => r.ledgerAccountId).map((r) => [r.qboId, r.ledgerAccountId!]));

  const qboRows = await db
    .select({
      id: qboTransactions.id,
      legs: qboTransactions.legs,
      deleted: qboTransactions.deleted,
      txnDate: qboTransactions.txnDate,
      paymentMethod: qboTransactions.paymentMethod,
      docNumber: qboTransactions.docNumber,
    })
    .from(qboTransactions)
    .where(eq(qboTransactions.connectionId, connectionId));
  const qboById = new Map(qboRows.map((row) => [row.id, row]));

  const linkRows = qboRows.length
    ? await db
      .select({
        id: qboTransactionLinks.id,
        qboTransactionId: qboTransactionLinks.qboTransactionId,
        leg: qboTransactionLinks.leg,
        transactionId: qboTransactionLinks.transactionId,
        method: qboTransactionLinks.method,
        status: qboTransactionLinks.status,
        txnAccountId: transactions.accountId,
        txnAmountCents: transactions.amountCents,
      })
      .from(qboTransactionLinks)
      .innerJoin(qboTransactions, eq(qboTransactionLinks.qboTransactionId, qboTransactions.id))
      .innerJoin(transactions, eq(qboTransactionLinks.transactionId, transactions.id))
      .where(eq(qboTransactions.connectionId, connectionId))
    : [];

  // 1. Drop auto links the QBO side no longer supports.
  const staleIds: string[] = [];
  for (const link of linkRows) {
    if (link.method !== 'auto' || link.status !== 'linked') continue;
    const qbo = qboById.get(link.qboTransactionId);
    const leg = qbo?.legs.find((l) => l.leg === link.leg);
    const ledgerAccountId = leg ? ledgerAccountByQbo.get(leg.accountQboId) ?? null : null;
    if (autoLinkIsStale(leg, qbo?.deleted ?? true, ledgerAccountId, { accountId: link.txnAccountId, amountCents: link.txnAmountCents })) {
      staleIds.push(link.id);
    }
  }
  if (staleIds.length) await db.delete(qboTransactionLinks).where(inArray(qboTransactionLinks.id, staleIds));
  const stale = new Set(staleIds);

  const linkedLegs = new Set<string>();
  const rejectedPairs = new Set<string>();
  for (const link of linkRows) {
    if (stale.has(link.id)) continue;
    // A leg the user unlinked by hand is theirs to decide: auto-linking never picks it up again
    // (otherwise dropping the only wrong candidate would auto-link the next one).
    linkedLegs.add(legKey(link.qboTransactionId, link.leg));
    if (link.status !== 'linked') rejectedPairs.add(pairKey(link.qboTransactionId, link.leg, link.transactionId));
  }

  // 2. Build legs on mapped accounts.
  const legs: LinkLeg[] = [];
  for (const row of qboRows) {
    if (row.deleted) continue;
    for (const leg of row.legs) {
      const ledgerAccountId = ledgerAccountByQbo.get(leg.accountQboId);
      if (!ledgerAccountId) continue;
      legs.push({
        qboTransactionId: row.id,
        leg: leg.leg,
        ledgerAccountId,
        amountCents: leg.amountCents,
        txnDate: row.txnDate,
        paymentMethod: row.paymentMethod,
        docNumber: row.docNumber,
      });
    }
  }
  if (!legs.length) return { created: [], removedStale: staleIds.length };

  const dates = legs.map((l) => l.txnDate).sort();
  const fromDate = shiftDate(dates[0], -LINK_WINDOW_DAYS);
  const toDate = shiftDate(dates[dates.length - 1], CHECK_CLEARING_DAYS);
  const ledgerAccountIds = Array.from(new Set(legs.map((l) => l.ledgerAccountId)));
  const txnRows = await db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      amountCents: transactions.amountCents,
      date: transactions.date,
      raw: transactions.raw,
    })
    .from(transactions)
    .where(and(
      eq(transactions.businessId, company.businessId),
      inArray(transactions.accountId, ledgerAccountIds),
      eq(transactions.pending, false),
      gte(transactions.date, fromDate),
      lte(transactions.date, toDate),
    ));

  // Ledger transactions linked to ANY QBO transaction (any connection) are taken.
  const takenRows = txnRows.length
    ? await db
      .select({ transactionId: qboTransactionLinks.transactionId })
      .from(qboTransactionLinks)
      .where(and(eq(qboTransactionLinks.status, 'linked'), inArray(qboTransactionLinks.transactionId, txnRows.map((t) => t.id))))
    : [];
  const linkedTransactionIds = new Set(takenRows.map((r) => r.transactionId));

  const plan = planAutoLinks(
    legs,
    txnRows.map((t) => ({ id: t.id, accountId: t.accountId, amountCents: t.amountCents, date: t.date, checkNumber: checkNumberFromRaw(t.raw) })),
    { linkedLegs, linkedTransactionIds, rejectedPairs },
  );

  const created: PlannedLink[] = [];
  for (const link of plan) {
    const inserted = await db.insert(qboTransactionLinks).values({
      qboTransactionId: link.qboTransactionId,
      leg: link.leg,
      transactionId: link.transactionId,
      method: 'auto',
      status: 'linked',
      confidence: link.confidence.toFixed(4),
      reasons: link.reasons,
    }).onConflictDoNothing().returning({ id: qboTransactionLinks.id });
    if (inserted.length) created.push(link);
  }
  return { created, removedStale: staleIds.length };
}

export function shiftDate(isoDate: string, days: number): string {
  const d = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
