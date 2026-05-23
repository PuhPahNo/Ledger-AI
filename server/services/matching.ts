import { and, eq, gte, lte, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { receiptMatches, receipts, transactions, type Receipt, type Transaction } from '../db/schema.js';

export interface MatchResult {
  transaction: Transaction;
  score: number;
  reasons: Record<string, number | string>;
}

const autoAttachThreshold = 0.82;
const suggestedThreshold = 0.5;

export async function matchReceipt(receiptId: string): Promise<MatchResult | null> {
  const receipt = await db.query.receipts.findFirst({ where: eq(receipts.id, receiptId) });
  if (!receipt || !receipt.totalCents || !receipt.receiptDate) return null;

  const candidates = await candidateTransactions(receipt);
  const scored = candidates
    .map((transaction) => scoreMatch(receipt, transaction))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < suggestedThreshold) return null;

  await db.insert(receiptMatches).values({
    receiptId,
    transactionId: best.transaction.id,
    score: best.score.toFixed(4),
    status: best.score >= autoAttachThreshold ? 'auto' : 'suggested',
    reasons: best.reasons,
  });

  if (best.score >= autoAttachThreshold) {
    await attachReceipt(best.transaction.id, receiptId);
  } else {
    await db.update(receipts).set({ status: 'pending', updatedAt: new Date() }).where(eq(receipts.id, receiptId));
  }
  return best;
}

export async function attachReceipt(transactionId: string, receiptId: string): Promise<Transaction | null> {
  const [updated] = await db
    .update(transactions)
    .set({ receiptId, receiptStatus: 'matched', updatedAt: new Date() })
    .where(eq(transactions.id, transactionId))
    .returning();

  await db
    .update(receipts)
    .set({ transactionId, status: 'matched', updatedAt: new Date() })
    .where(eq(receipts.id, receiptId));

  await db
    .update(receiptMatches)
    .set({ status: 'accepted', decidedAt: new Date() })
    .where(and(eq(receiptMatches.receiptId, receiptId), eq(receiptMatches.transactionId, transactionId)));

  return updated ?? null;
}

async function candidateTransactions(receipt: Receipt): Promise<Transaction[]> {
  const date = new Date(`${receipt.receiptDate}T00:00:00Z`);
  const from = new Date(date);
  from.setUTCDate(from.getUTCDate() - 5);
  const to = new Date(date);
  to.setUTCDate(to.getUTCDate() + 5);

  return db
    .select()
    .from(transactions)
    .where(and(
      gte(transactions.date, from.toISOString().slice(0, 10)),
      lte(transactions.date, to.toISOString().slice(0, 10)),
      receipt.businessId
        ? eq(transactions.businessId, receipt.businessId)
        : sql`true`,
      or(eq(transactions.receiptStatus, 'missing'), eq(transactions.receiptStatus, 'pending')),
    ))
    .limit(50);
}

export function scoreMatch(receipt: Receipt, transaction: Transaction): MatchResult {
  const amountScore = scoreAmount(receipt.totalCents, transaction.amountCents);
  const dateScore = scoreDate(receipt.receiptDate, transaction.date);
  const merchantScore = scoreMerchant(receipt.merchant ?? '', transaction.merchant);
  const businessScore = receipt.businessId && receipt.businessId === transaction.businessId ? 1 : 0.7;
  const score = round((amountScore * 0.45) + (merchantScore * 0.3) + (dateScore * 0.15) + (businessScore * 0.1));
  return {
    transaction,
    score,
    reasons: { amountScore, merchantScore, dateScore, businessScore },
  };
}

function scoreAmount(receiptCents: number | null, transactionCents: number): number {
  if (!receiptCents) return 0;
  const txn = Math.abs(transactionCents);
  const delta = Math.abs(Math.abs(receiptCents) - txn);
  if (delta <= 2) return 1;
  const tolerance = Math.max(100, txn * 0.02);
  return Math.max(0, 1 - delta / tolerance);
}

function scoreDate(receiptDate: string | null, transactionDate: string): number {
  if (!receiptDate) return 0;
  const deltaDays = Math.abs((Date.parse(receiptDate) - Date.parse(transactionDate)) / 86_400_000);
  if (deltaDays <= 1) return 1;
  if (deltaDays > 5) return 0;
  return round(1 - deltaDays / 5);
}

function scoreMerchant(receiptMerchant: string, transactionMerchant: string): number {
  const a = tokens(receiptMerchant);
  const b = tokens(transactionMerchant);
  if (!a.size || !b.size) return 0;
  const overlap = [...a].filter((token) => b.has(token)).length;
  const union = new Set([...a, ...b]).size;
  return round(overlap / union);
}

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((token) => token.length > 1));
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
