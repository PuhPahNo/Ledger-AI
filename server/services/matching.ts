import { and, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { accounts, businesses, categories, receiptMatches, receipts, transactions, type Receipt, type Transaction } from '../db/schema.js';
import { getReceiptTrackingSince } from './appSettings.js';
import { reviewReceiptCategoryEvidence } from './categorizationFeedback.js';
import {
  AUTO_ATTACH_THRESHOLD,
  MIN_EXTRACTION_CONFIDENCE_FOR_AUTO_ATTACH,
  SUGGESTED_THRESHOLD,
} from './receiptMatchThresholds.js';
import { applyTagRulesBestEffort } from './tagging.js';

export { AUTO_ATTACH_THRESHOLD, MIN_EXTRACTION_CONFIDENCE_FOR_AUTO_ATTACH, SUGGESTED_THRESHOLD };

export interface MatchResult {
  transaction: Transaction;
  score: number;
  reasons: Record<string, number | string>;
}

export interface ScoredCandidate extends MatchResult {
  /** Receipt total equals the transaction amount (within rounding). */
  exactAmount: boolean;
}

export interface ReceiptMatchOutcome extends MatchResult {
  /** True when the score cleared the auto-attach bar and the receipt was attached to the transaction. */
  attached: boolean;
}

export interface ReceiptMatchCandidate extends ScoredCandidate {
  transaction: Transaction & {
    businessKey?: string | null;
    categoryName?: string | null;
    categoryTaxCode?: string | null;
  };
  ambiguous: boolean;
  suggested: boolean;
  wouldAutoAttach: boolean;
}

type ReceiptStatus = Receipt['status'];

/** Receipt fields a user can correct by hand; extraction retries never overwrite these. */
export const RECEIPT_EDITABLE_FIELDS = ['merchant', 'totalCents', 'receiptDate'] as const;
export type ReceiptEditableField = typeof RECEIPT_EDITABLE_FIELDS[number];

/**
 * The receipt's user-edited field list after a manual edit: previously edited fields plus any
 * field whose submitted value differs from what's stored (re-saving an unchanged extracted value
 * doesn't lock it).
 */
export function mergeUserEditedFields(
  current: string[] | null | undefined,
  existing: Pick<Receipt, ReceiptEditableField>,
  body: Partial<Record<ReceiptEditableField, string | number | null | undefined>>,
): string[] {
  const changed = RECEIPT_EDITABLE_FIELDS.filter((field) => body[field] !== undefined && body[field] !== existing[field]);
  return [...new Set([...(current ?? []), ...changed])];
}

const REMATCH_BATCH_LIMIT = 200;
const CANDIDATE_POOL_LIMIT = 200;

// ---------------------------------------------------------------------------------------------
// Pure policy
// ---------------------------------------------------------------------------------------------

export type MatchSkipReason = 'not_pending' | 'already_matched' | 'missing_details';

/**
 * Why the matcher must leave this receipt alone, or null when it may run. Dismissed ('n/a')
 * and matched receipts are final — only the user moves them (dismiss/unpair/pair).
 */
export function receiptMatchSkipReason(
  receipt: Pick<Receipt, 'status' | 'transactionId' | 'totalCents' | 'receiptDate'>,
): MatchSkipReason | null {
  if (receipt.transactionId || receipt.status === 'matched') return 'already_matched';
  if (receipt.status !== 'pending') return 'not_pending';
  if (!receipt.totalCents || !receipt.receiptDate) return 'missing_details';
  return null;
}

/**
 * Whether the receipt's total and date are trustworthy enough for the matcher to pair on its own.
 * Each must be either typed by the user or come from a confident extraction; otherwise the best
 * candidate is only suggested.
 */
export function receiptAutoAttachEligible(
  receipt: Pick<Receipt, 'totalCents' | 'receiptDate' | 'confidence'> & { userEditedFields?: string[] | null },
): boolean {
  if (!receipt.totalCents || !receipt.receiptDate) return false;
  const edited = new Set(receipt.userEditedFields ?? []);
  if (edited.has('totalCents') && edited.has('receiptDate')) return true;
  const confidence = receipt.confidence == null ? NaN : Number(receipt.confidence);
  return Number.isFinite(confidence) && confidence >= MIN_EXTRACTION_CONFIDENCE_FOR_AUTO_ATTACH;
}

/**
 * Decide whether the best-scoring candidate should be auto-attached or left as a suggestion.
 * Pure so the policy is unit-testable. `scored` must be sorted by descending score.
 *
 * Attaches when the score clears the auto-attach bar, OR when there is an *unambiguous* exact
 * amount + in-window date match whose card doesn't contradict (covers receipts whose payee name
 * never resembles the bank descriptor, e.g. taxes/invoices). Never attaches when a runner-up is
 * essentially tied — we can't tell which transaction it belongs to — or when the receipt's
 * extracted details aren't trustworthy (`allowAutoAttach: false`).
 */
export function decideMatch(
  scored: ScoredCandidate[],
  options: { allowAutoAttach?: boolean } = {},
): { best: ScoredCandidate; attach: boolean } | null {
  const best = scored[0];
  if (!best || best.score < SUGGESTED_THRESHOLD) return null;

  const exactUnique = best.exactAmount
    && scored.filter((candidate) => candidate.exactAmount).length === 1
    && Number(best.reasons.dateScore) > 0
    && Number(best.reasons.cardScore) >= 0.5; // card matches or is unknown — not a contradiction

  const attach = (options.allowAutoAttach ?? true)
    && !isAmbiguous(scored)
    && (best.score >= AUTO_ATTACH_THRESHOLD || exactUnique);
  return { best, attach };
}

function isAmbiguous(scored: ScoredCandidate[]): boolean {
  const [best, runnerUp] = scored;
  return Boolean(best && runnerUp && runnerUp.score >= SUGGESTED_THRESHOLD && best.score - runnerUp.score < 0.02);
}

export function annotateCandidates<T extends ScoredCandidate>(
  scored: T[],
  options: { allowAutoAttach?: boolean } = {},
): Array<T & {
  ambiguous: boolean;
  suggested: boolean;
  wouldAutoAttach: boolean;
}> {
  const decision = decideMatch(scored, options);
  const bestId = decision?.best.transaction.id;
  const ambiguous = isAmbiguous(scored);
  return scored.map((candidate) => ({
    ...candidate,
    ambiguous: candidate.transaction.id === bestId && ambiguous,
    suggested: candidate.transaction.id === bestId && Boolean(decision),
    wouldAutoAttach: candidate.transaction.id === bestId && Boolean(decision?.attach),
  }));
}

export type ReceiptMatchPlan =
  /** Nothing cleared the suggestion bar: stale 'suggested' rows must be removed. */
  | { action: 'clear' }
  | { action: 'suggest'; best: ScoredCandidate }
  | { action: 'attach'; best: ScoredCandidate };

/** What a (re-)match run should write. Every action first drops the receipt's undecided suggestions. */
export function planReceiptMatch(
  receipt: Parameters<typeof receiptAutoAttachEligible>[0],
  scored: ScoredCandidate[],
): ReceiptMatchPlan {
  const decision = decideMatch(scored, { allowAutoAttach: receiptAutoAttachEligible(receipt) });
  if (!decision) return { action: 'clear' };
  return decision.attach ? { action: 'attach', best: decision.best } : { action: 'suggest', best: decision.best };
}

/**
 * The receipt status a transaction falls back to once it loses its receipt: what Plaid import
 * would have assigned (inflows are n/a, spend before the tracking cutoff is waived). Statuses the
 * user set deliberately (anything other than 'matched') are kept.
 */
export function detachedTransactionReceiptStatus(
  transaction: Pick<Transaction, 'amountCents' | 'date' | 'receiptStatus'>,
  receiptTrackingSince: string | null,
): ReceiptStatus {
  if (transaction.receiptStatus !== 'matched') return transaction.receiptStatus;
  if (transaction.amountCents >= 0) return 'n/a';
  if (receiptTrackingSince && transaction.date < receiptTrackingSince) return 'waived';
  return 'missing';
}

type LinkReceipt = Pick<Receipt, 'id' | 'status' | 'transactionId'>;
type LinkTransaction = Pick<Transaction, 'id' | 'receiptId' | 'receiptStatus' | 'amountCents' | 'date'>;

export interface PairingWritePlan {
  /** Transactions to clear `receiptId` on, with the status each falls back to. */
  detachTransactions: Array<{ id: string; receiptStatus: ReceiptStatus }>;
  /** Receipts to clear `transactionId` on and return to the review queue ('pending'). */
  releaseReceiptIds: string[];
  /** Pairs to record as rejected so the matcher never re-proposes them. */
  rejectPairs: Array<{ receiptId: string; transactionId: string }>;
}

export type AttachPlan =
  | { ok: false; reason: 'receipt_not_pending' | 'receipt_taken' | 'transaction_taken' | 'transaction_not_open' }
  | ({ ok: true; alreadyPaired: boolean } & PairingWritePlan);

/**
 * Plan pairing `receipt` with `transaction`. `receiptHolders` are every transaction that currently
 * points at the receipt (or that the receipt points at); `transactionReceipts` every receipt linked
 * to the transaction from either side. Manual pairs steal: old counterparts are released and the
 * broken pairs recorded as rejected. Auto pairs never steal — they only fill empty slots.
 */
export function planAttach(input: {
  receipt: LinkReceipt;
  transaction: LinkTransaction;
  receiptHolders: LinkTransaction[];
  transactionReceipts: LinkReceipt[];
  mode: 'manual' | 'auto';
  receiptTrackingSince: string | null;
}): AttachPlan {
  const { receipt, transaction, mode } = input;
  const otherHolders = uniqueById(input.receiptHolders).filter((row) => row.id !== transaction.id);
  const otherReceipts = uniqueById(input.transactionReceipts).filter((row) => row.id !== receipt.id);

  if (mode === 'auto') {
    if (receipt.status !== 'pending') return { ok: false, reason: 'receipt_not_pending' };
    if (receipt.transactionId || otherHolders.length > 0) return { ok: false, reason: 'receipt_taken' };
    if (transaction.receiptId || otherReceipts.length > 0) return { ok: false, reason: 'transaction_taken' };
    if (transaction.receiptStatus !== 'missing' && transaction.receiptStatus !== 'pending') {
      return { ok: false, reason: 'transaction_not_open' };
    }
  }

  const alreadyPaired = receipt.transactionId === transaction.id
    && transaction.receiptId === receipt.id
    && otherHolders.length === 0
    && otherReceipts.length === 0;

  return {
    ok: true,
    alreadyPaired,
    detachTransactions: otherHolders.map((row) => ({
      id: row.id,
      receiptStatus: detachedTransactionReceiptStatus(row, input.receiptTrackingSince),
    })),
    releaseReceiptIds: otherReceipts.map((row) => row.id),
    rejectPairs: [
      ...otherHolders.map((row) => ({ receiptId: receipt.id, transactionId: row.id })),
      ...otherReceipts.map((row) => ({ receiptId: row.id, transactionId: transaction.id })),
    ],
  };
}

/**
 * Plan detaching a receipt from whatever holds it. The pair is recorded as rejected so rematch
 * sweeps never put it back; both sides return to their unpaired state.
 */
export function planUnpair(input: {
  receipt: LinkReceipt;
  receiptHolders: LinkTransaction[];
  receiptTrackingSince: string | null;
}): PairingWritePlan {
  const holders = uniqueById(input.receiptHolders);
  return {
    detachTransactions: holders.map((row) => ({
      id: row.id,
      receiptStatus: detachedTransactionReceiptStatus(row, input.receiptTrackingSince),
    })),
    releaseReceiptIds: input.receipt.transactionId || holders.length > 0 || input.receipt.status === 'matched'
      ? [input.receipt.id]
      : [],
    rejectPairs: holders.map((row) => ({ receiptId: input.receipt.id, transactionId: row.id })),
  };
}

function uniqueById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Map<string, T>();
  for (const row of rows) if (!seen.has(row.id)) seen.set(row.id, row);
  return [...seen.values()];
}

// ---------------------------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------------------------

export async function matchReceipt(receiptId: string): Promise<ReceiptMatchOutcome | null> {
  const receipt = await db.query.receipts.findFirst({ where: eq(receipts.id, receiptId) });
  // Dismissed, already-paired, or detail-less receipts are never touched by the matcher.
  if (!receipt || receiptMatchSkipReason(receipt)) return null;

  await db.update(receipts).set({ lastMatchAttemptAt: new Date() }).where(eq(receipts.id, receiptId));

  const candidates = await candidateTransactions(receipt);
  // Don't re-suggest pairs the user already rejected (dismissed, unpaired, or paired elsewhere) —
  // that's the feedback signal that keeps the matcher from repeating its mistakes.
  const rejectedTransactionIds = await rejectedTransactionIdsForReceipt(receiptId);
  const scored = candidates
    .filter(({ transaction }) => !rejectedTransactionIds.has(transaction.id))
    .map(({ transaction, accountMask }) => {
      const result = scoreMatch(receipt, transaction, accountMask);
      return { ...result, exactAmount: isExactAmount(receipt.totalCents, transaction.amountCents) };
    })
    .sort((a, b) => b.score - a.score);
  const plan = planReceiptMatch(receipt, scored);

  if (plan.action === 'attach') {
    await deleteUndecidedSuggestions(db, receiptId);
    const attached = await attachReceipt(plan.best.transaction.id, receiptId, {
      mode: 'auto',
      score: plan.best.score,
      reasons: plan.best.reasons,
    });
    // Lost a race (either side was paired meanwhile) — the next sweep re-evaluates.
    return { ...plan.best, attached: Boolean(attached) };
  }

  // Idempotent across re-runs: stale undecided suggestions go, then the new best (if any) is recorded.
  await db.transaction(async (tx) => {
    await deleteUndecidedSuggestions(tx, receiptId);
    if (plan.action === 'suggest') {
      await tx.insert(receiptMatches).values({
        receiptId,
        transactionId: plan.best.transaction.id,
        score: plan.best.score.toFixed(4),
        status: 'suggested',
        reasons: plan.best.reasons,
      });
    }
  });
  return plan.action === 'suggest' ? { ...plan.best, attached: false } : null;
}

type DbExecutor = Pick<typeof db, 'delete' | 'insert' | 'select' | 'update'>;

async function deleteUndecidedSuggestions(executor: DbExecutor, receiptId: string): Promise<void> {
  await executor
    .delete(receiptMatches)
    .where(and(eq(receiptMatches.receiptId, receiptId), eq(receiptMatches.status, 'suggested')));
}

export async function receiptMatchCandidates(receiptId: string): Promise<ReceiptMatchCandidate[]> {
  const receipt = await db.query.receipts.findFirst({ where: eq(receipts.id, receiptId) });
  if (!receipt || !receipt.totalCents || !receipt.receiptDate) return [];
  const candidates = await candidateTransactionRows(receipt);
  // Rejected pairs stay listed (the user may still pair manually) but are excluded from
  // suggestion/auto-attach annotations, matching matchReceipt's decision policy.
  const rejectedTransactionIds = await rejectedTransactionIdsForReceipt(receiptId);
  const scored = candidates
    .map(({ transaction, accountMask }) => {
      const result = scoreMatch(receipt, transaction, accountMask);
      return { ...result, exactAmount: isExactAmount(receipt.totalCents, transaction.amountCents) };
    })
    .sort((a, b) => b.score - a.score);
  const eligible = scored.filter(({ transaction }) => !rejectedTransactionIds.has(transaction.id));
  const annotated = annotateCandidates(eligible, { allowAutoAttach: receiptAutoAttachEligible(receipt) });
  const annotatedById = new Map(annotated.map((candidate) => [candidate.transaction.id, candidate]));
  return scored.map((candidate) => annotatedById.get(candidate.transaction.id) ?? {
    ...candidate,
    ambiguous: false,
    suggested: false,
    wouldAutoAttach: false,
  });
}

async function rejectedTransactionIdsForReceipt(receiptId: string): Promise<Set<string>> {
  const rows = await db
    .select({ transactionId: receiptMatches.transactionId })
    .from(receiptMatches)
    .where(and(eq(receiptMatches.receiptId, receiptId), eq(receiptMatches.status, 'rejected')));
  return new Set(rows.map((row) => row.transactionId));
}

/**
 * Retry matching for receipts that were ingested but never attached to a transaction —
 * e.g. an emailed receipt that arrived before the card charge posted from Plaid. Runs after a
 * Plaid sync brings in new transactions and on a periodic safety-net sweep. Only considers
 * receipts that have the total + date `matchReceipt` needs, and is bounded per run. The
 * least-recently-tried receipts go first (never-tried, then oldest attempt; newest receipts
 * break ties) so a large backlog rotates instead of starving everything past the first batch.
 */
export async function rematchUnmatchedReceipts(
  options: { limit?: number } = {},
): Promise<{ processed: number; attached: number }> {
  const limit = options.limit ?? REMATCH_BATCH_LIMIT;
  const pending = await db
    .select({ id: receipts.id })
    .from(receipts)
    .where(and(
      isNull(receipts.transactionId),
      eq(receipts.status, 'pending'),
      sql`${receipts.totalCents} IS NOT NULL`,
      sql`${receipts.receiptDate} IS NOT NULL`,
    ))
    .orderBy(sql`${receipts.lastMatchAttemptAt} ASC NULLS FIRST`, desc(receipts.createdAt))
    .limit(limit);

  let attached = 0;
  for (const row of pending) {
    const outcome = await matchReceipt(row.id);
    if (outcome?.attached) attached += 1;
  }
  return { processed: pending.length, attached };
}

export interface AttachReceiptOptions {
  /**
   * 'manual' (default): the user chose this pair — any previous counterpart on either side is
   * released and the broken pair recorded as rejected. 'auto': the matcher's pick — refuses
   * (returns null) unless both sides are still unpaired and the receipt is pending.
   */
  mode?: 'manual' | 'auto';
  score?: number;
  reasons?: Record<string, unknown>;
}

/**
 * Pair a receipt with a transaction, atomically. Both rows (and any current counterparts) are
 * locked, so concurrent pairs can't leave two transactions pointing at one receipt — the unique
 * index on transactions.receipt_id is the backstop. Returns the updated transaction, or null when
 * either row is missing or an auto pair was refused.
 */
export async function attachReceipt(
  transactionId: string,
  receiptId: string,
  options: AttachReceiptOptions = {},
): Promise<Transaction | null> {
  const mode = options.mode ?? 'manual';
  const receiptTrackingSince = await getReceiptTrackingSince();

  const result = await db.transaction(async (tx) => {
    // Lock order everywhere: receipt, then transactions — avoids deadlocks with unpair.
    const [receipt] = await tx.select().from(receipts).where(eq(receipts.id, receiptId)).for('update');
    if (!receipt) return null;
    const [transaction] = await tx.select().from(transactions).where(eq(transactions.id, transactionId)).for('update');
    if (!transaction) return null;

    const receiptHolders = await tx
      .select()
      .from(transactions)
      .where(or(
        eq(transactions.receiptId, receiptId),
        receipt.transactionId ? eq(transactions.id, receipt.transactionId) : sql`false`,
      ))
      .for('update');
    const transactionReceipts = await tx
      .select()
      .from(receipts)
      .where(or(
        eq(receipts.transactionId, transactionId),
        transaction.receiptId ? eq(receipts.id, transaction.receiptId) : sql`false`,
      ))
      .for('update');

    const plan = planAttach({
      receipt,
      transaction,
      // A receipt pointer to a transaction that doesn't point back is still a stale link to clear.
      receiptHolders,
      transactionReceipts,
      mode,
      receiptTrackingSince,
    });
    if (!plan.ok) return null;
    if (plan.alreadyPaired) return { transaction, newlyPaired: false, score: null as number | null };

    await applyPairingWrites(tx, plan, [...receiptHolders, transaction], [...transactionReceipts, receipt]);

    const [updated] = await tx
      .update(transactions)
      .set({ receiptId, receiptStatus: 'matched', updatedAt: new Date() })
      .where(eq(transactions.id, transactionId))
      .returning();
    await tx
      .update(receipts)
      .set({ transactionId, status: 'matched', updatedAt: new Date() })
      .where(eq(receipts.id, receiptId));

    const pairStatus = mode === 'auto' ? 'auto' as const : 'accepted' as const;
    const [existing] = await tx
      .select({ id: receiptMatches.id, score: receiptMatches.score })
      .from(receiptMatches)
      .where(and(eq(receiptMatches.receiptId, receiptId), eq(receiptMatches.transactionId, transactionId)))
      .orderBy(desc(receiptMatches.createdAt))
      .limit(1);
    let score: number;
    if (existing) {
      score = options.score ?? Number(existing.score);
      await tx
        .update(receiptMatches)
        .set({ status: pairStatus, decidedAt: new Date() })
        .where(and(eq(receiptMatches.receiptId, receiptId), eq(receiptMatches.transactionId, transactionId)));
    } else {
      // A manual pair the matcher never proposed still deserves a match record — it's both the
      // audit trail and a labeled example of what the scorer missed.
      const scored = options.score == null ? scoreMatch(receipt, transaction) : null;
      score = options.score ?? scored!.score;
      await tx.insert(receiptMatches).values({
        receiptId,
        transactionId,
        score: score.toFixed(4),
        status: pairStatus,
        reasons: options.reasons ?? { ...scored!.reasons, manualPair: true },
        decidedAt: new Date(),
      });
    }

    // Pairing elsewhere is an implicit rejection of the other suggestions — record it so
    // rematch sweeps never surface the same wrong pair again.
    await tx
      .update(receiptMatches)
      .set({ status: 'rejected', decidedAt: new Date() })
      .where(and(
        eq(receiptMatches.receiptId, receiptId),
        eq(receiptMatches.status, 'suggested'),
        ne(receiptMatches.transactionId, transactionId),
      ));

    return { transaction: updated ?? transaction, newlyPaired: true, score };
  });

  if (!result) return null;
  if (result.newlyPaired) {
    // Enrichment runs after commit: a slow/failed AI call must not undo the user's pairing.
    try {
      await reviewReceiptCategoryEvidence({ transactionId, receiptId, matchScore: result.score });
      // Pairing may add richer category evidence and receipt-only tag signals. Re-run
      // tags after category review so the final linked transaction is fully enriched.
      await applyTagRulesBestEffort(transactionId);
    } catch (error) {
      console.warn('[matching] post-pair enrichment failed', { transactionId, receiptId, error });
    }
  }
  return result.transaction;
}

/**
 * Detach a receipt from its transaction ("unpair"). Records the pair as rejected so auto-match
 * won't re-pair it, returns the receipt to the review queue, and resets the transaction's receipt
 * status. Returns null when the receipt doesn't exist.
 */
export async function unpairReceipt(receiptId: string): Promise<{ receiptId: string; transactionIds: string[] } | null> {
  const receiptTrackingSince = await getReceiptTrackingSince();
  return db.transaction(async (tx) => {
    const [receipt] = await tx.select().from(receipts).where(eq(receipts.id, receiptId)).for('update');
    if (!receipt) return null;
    const receiptHolders = await tx
      .select()
      .from(transactions)
      .where(or(
        eq(transactions.receiptId, receiptId),
        receipt.transactionId ? eq(transactions.id, receipt.transactionId) : sql`false`,
      ))
      .for('update');
    const plan = planUnpair({ receipt, receiptHolders, receiptTrackingSince });
    await applyPairingWrites(tx, plan, receiptHolders, [receipt]);
    return { receiptId, transactionIds: plan.detachTransactions.map((row) => row.id) };
  });
}

/** Execute the release/reject half of a pairing plan inside the caller's DB transaction. */
async function applyPairingWrites(
  tx: DbExecutor,
  plan: PairingWritePlan,
  knownTransactions: Transaction[],
  knownReceipts: Receipt[],
): Promise<void> {
  const now = new Date();
  // Transactions first: the receipt must be free before anything else claims it (unique index).
  for (const row of plan.detachTransactions) {
    await tx
      .update(transactions)
      .set({ receiptId: null, receiptStatus: row.receiptStatus, updatedAt: now })
      .where(eq(transactions.id, row.id));
  }
  if (plan.releaseReceiptIds.length > 0) {
    await tx
      .update(receipts)
      .set({ transactionId: null, status: 'pending', updatedAt: now })
      .where(inArray(receipts.id, plan.releaseReceiptIds));
  }
  for (const pair of plan.rejectPairs) {
    const rejected = await tx
      .update(receiptMatches)
      .set({ status: 'rejected', decidedAt: now })
      .where(and(eq(receiptMatches.receiptId, pair.receiptId), eq(receiptMatches.transactionId, pair.transactionId)))
      .returning({ id: receiptMatches.id });
    if (rejected.length > 0) continue;
    const receipt = knownReceipts.find((row) => row.id === pair.receiptId);
    const transaction = knownTransactions.find((row) => row.id === pair.transactionId);
    if (!receipt || !transaction) continue;
    const scored = scoreMatch(receipt, transaction);
    await tx.insert(receiptMatches).values({
      receiptId: pair.receiptId,
      transactionId: pair.transactionId,
      score: scored.score.toFixed(4),
      status: 'rejected',
      reasons: { ...scored.reasons, unpaired: true },
      decidedAt: now,
    });
  }
}

interface Candidate {
  transaction: Transaction;
  /** Last-4 card mask of the transaction's account, when known. */
  accountMask: string | null;
}

async function candidateTransactions(receipt: Receipt): Promise<Candidate[]> {
  const rows = await candidateTransactionRows(receipt);
  return rows.map(({ transaction, accountMask }) => ({ transaction, accountMask }));
}

async function candidateTransactionRows(receipt: Receipt): Promise<Array<{
  transaction: Transaction & {
    businessKey?: string | null;
    categoryName?: string | null;
    categoryTaxCode?: string | null;
  };
  accountMask: string | null;
}>> {
  const date = new Date(`${receipt.receiptDate}T00:00:00Z`);
  const from = new Date(date);
  from.setUTCDate(from.getUTCDate() - 5);
  const to = new Date(date);
  to.setUTCDate(to.getUTCDate() + 5);
  const fromDate = from.toISOString().slice(0, 10);
  const toDate = to.toISOString().slice(0, 10);
  const receiptTotal = Math.abs(receipt.totalCents ?? 0);
  const receiptDate = receipt.receiptDate!;

  const rows = await db
    .select({
      transaction: transactions,
      accountMask: accounts.mask,
      businessKey: businesses.key,
      categoryName: categories.name,
      categoryTaxCode: categories.taxCode,
    })
    .from(transactions)
    .innerJoin(businesses, eq(transactions.businessId, businesses.id))
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(and(
      // Plaid's posted date can lag the card authorization by several days. Search on
      // either date so a weekend/slow-settling charge is still eligible for scoring.
      or(
        and(gte(transactions.date, fromDate), lte(transactions.date, toDate)),
        and(gte(transactions.authorizedDate, fromDate), lte(transactions.authorizedDate, toDate)),
      ),
      receipt.businessId
        ? eq(transactions.businessId, receipt.businessId)
        : sql`true`,
      or(eq(transactions.receiptStatus, 'missing'), eq(transactions.receiptStatus, 'pending')),
    ))
    // High-volume businesses can easily have more than 50 transactions in an 11-day
    // window. Rank before bounding the candidate set so exact/near amounts cannot be
    // dropped by an arbitrary database row order.
    .orderBy(
      sql`abs(abs(${transactions.amountCents}) - ${receiptTotal})`,
      sql`least(
        abs(${transactions.date} - ${receiptDate}::date),
        coalesce(abs(${transactions.authorizedDate} - ${receiptDate}::date), 999)
      )`,
    )
    .limit(CANDIDATE_POOL_LIMIT);

  return rows.map((row) => ({
    transaction: {
      ...row.transaction,
      businessKey: row.businessKey,
      categoryName: row.categoryName,
      categoryTaxCode: row.categoryTaxCode,
    },
    accountMask: row.accountMask ?? null,
  }));
}


/**
 * Score a receipt against a transaction. Amount and date carry the match; merchant similarity and
 * the card last-4 are corroborating signals (merchant names on receipts rarely resemble the bank
 * descriptor, so it can't be a gate). `accountMask` is the transaction account's last-4, if known.
 */
export function scoreMatch(receipt: Receipt, transaction: Transaction, accountMask: string | null = null): MatchResult {
  const amountScore = scoreAmount(receipt.totalCents, transaction.amountCents);
  const postedDateScore = scoreDate(receipt.receiptDate, transaction.date);
  const authorizedDateScore = transaction.authorizedDate
    ? scoreDate(receipt.receiptDate, transaction.authorizedDate)
    : 0;
  const dateScore = Math.max(postedDateScore, authorizedDateScore);
  const dateBasis = authorizedDateScore > postedDateScore ? 'authorized' : 'posted';
  const merchantScore = scoreMerchant(receipt.merchant ?? '', transaction.merchant);
  const businessScore = receipt.businessId && receipt.businessId === transaction.businessId ? 1 : 0.7;
  const cardScore = scoreCard(receiptLast4(receipt), accountMask);
  const score = round(
    (amountScore * 0.45) + (dateScore * 0.25) + (merchantScore * 0.15) + (cardScore * 0.1) + (businessScore * 0.05),
  );
  return {
    transaction,
    score,
    reasons: { amountScore, merchantScore, dateScore, dateBasis, cardScore, businessScore },
  };
}

function isExactAmount(receiptCents: number | null, transactionCents: number): boolean {
  if (!receiptCents) return false;
  return Math.abs(Math.abs(receiptCents) - Math.abs(transactionCents)) <= 2;
}

/** 1 when the receipt's card matches the account, 0 on a known contradiction, 0.5 when unknown. */
function scoreCard(receiptCardLast4: string | null, accountMask: string | null): number {
  const receiptDigits = normalizeLast4(receiptCardLast4);
  const accountDigits = normalizeLast4(accountMask);
  if (!receiptDigits || !accountDigits) return 0.5;
  return receiptDigits === accountDigits ? 1 : 0;
}

function normalizeLast4(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function receiptLast4(receipt: Receipt): string | null {
  const raw = (receipt.ocrJson as Record<string, unknown> | null | undefined)?.paymentLast4;
  return typeof raw === 'string' ? raw : null;
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
  // Word-overlap similarity (handles reordered/partial names).
  const a = tokens(receiptMerchant);
  const b = tokens(transactionMerchant);
  let jaccard = 0;
  if (a.size && b.size) {
    const overlap = [...a].filter((token) => b.has(token)).length;
    jaccard = overlap / new Set([...a, ...b]).size;
  }
  // Condensed similarity — strips spaces/punctuation/suffixes/TLDs so "Eleven Labs Inc."
  // and "Elevenlabs.io" both reduce to "elevenlabs". Bank descriptors rarely match the
  // receipt payee word-for-word, so this catches the common case word overlap misses.
  const na = condenseMerchant(receiptMerchant);
  const nb = condenseMerchant(transactionMerchant);
  let condensed = 0;
  if (na && nb) {
    if (na === nb) condensed = 1;
    else if (na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na))) condensed = 0.9;
  }
  return round(Math.max(jaccard, condensed));
}

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((token) => token.length > 1));
}

/** Reduce a merchant name to comparable letters: drop TLDs, corporate suffixes, and punctuation. */
function condenseMerchant(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.(io|com|net|org|ai|app|co|inc|gov|biz)\b/g, ' ')
    .replace(/\b(inc|llc|ltd|co|corp|corporation|company|the|payment|payments|pymt|bill|subscription)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '');
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
