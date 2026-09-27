import { describe, expect, it } from 'vitest';
import {
  AUTO_ATTACH_THRESHOLD,
  annotateCandidates,
  decideMatch,
  detachedTransactionReceiptStatus,
  mergeUserEditedFields,
  planAttach,
  planReceiptMatch,
  planUnpair,
  receiptAutoAttachEligible,
  receiptMatchSkipReason,
  scoreMatch,
  type PairingWritePlan,
  type ScoredCandidate,
} from './matching.js';
import type { Receipt, Transaction } from '../db/schema.js';

function makeReceipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    id: 'r1',
    businessId: 'b1',
    source: 'gmail',
    status: 'pending',
    merchant: 'Sweetgreen',
    totalCents: 3821,
    receiptDate: '2026-05-22',
    fileKey: null,
    fileName: null,
    mimeType: null,
    fileSha256: null,
    gmailMessageId: null,
    gmailAttachmentId: null,
    uploadedByUserId: null,
    uploadedByUploaderId: null,
    transactionId: null,
    confidence: null,
    ocrJson: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Receipt;
}

function makeTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 't1',
    businessId: 'b1',
    accountId: null,
    plaidTransactionId: null,
    date: '2026-05-22',
    authorizedDate: null,
    merchant: 'Sweetgreen',
    amountCents: -3821,
    categoryId: null,
    categorySource: 'uncategorized',
    categoryConfidence: null,
    categoryEvidence: {},
    receiptId: null,
    receiptStatus: 'missing',
    sourceLabel: 'Amex 4002',
    note: null,
    flag: null,
    pending: false,
    raw: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Transaction;
}

describe('scoreMatch', () => {
  it('strongly scores same merchant, amount, date, and business', () => {
    const result = scoreMatch(makeReceipt(), makeTransaction());
    expect(result.score).toBeGreaterThanOrEqual(0.95);
  });

  it('penalizes wrong amount and merchant', () => {
    const result = scoreMatch(
      makeReceipt({ merchant: 'Apple Store', totalCents: 99900 }),
      makeTransaction(),
    );
    expect(result.score).toBeLessThan(0.5);
  });

  it('rewards a matching card last-4 and penalizes a contradicting one', () => {
    // Tax-style receipt: exact amount + date, but payee name never resembles the bank descriptor.
    const receipt = makeReceipt({
      merchant: 'Federal and Georgia tax authorities',
      ocrJson: { paymentLast4: '4002' },
    });
    const transaction = makeTransaction({ merchant: 'IRS USATAXPYMT' });

    const matched = scoreMatch(receipt, transaction, '4002');
    const unknown = scoreMatch(receipt, transaction, null);
    const contradicted = scoreMatch(receipt, transaction, '9999');

    expect(matched.score).toBeGreaterThan(unknown.score);
    expect(unknown.score).toBeGreaterThan(contradicted.score);
    // A confirmed card match should clear the auto-attach bar even with zero merchant overlap.
    expect(matched.score).toBeGreaterThanOrEqual(AUTO_ATTACH_THRESHOLD);
  });

  it('matches "Eleven Labs Inc." to bank descriptor "Elevenlabs.io" via condensed name', () => {
    const result = scoreMatch(
      makeReceipt({ merchant: 'Eleven Labs Inc.', totalCents: 2376, receiptDate: '2026-03-25' }),
      makeTransaction({ merchant: 'Elevenlabs.io', amountCents: -2376, date: '2026-03-26' }),
    );
    // Strong amount + date + condensed-merchant match should auto-attach even without card info.
    expect(Number(result.reasons.merchantScore)).toBeGreaterThanOrEqual(0.9);
    expect(result.score).toBeGreaterThanOrEqual(AUTO_ATTACH_THRESHOLD);
  });

  it('uses the authorization date when the posted date lags the receipt', () => {
    const result = scoreMatch(
      makeReceipt({ receiptDate: '2026-07-03' }),
      makeTransaction({ date: '2026-07-09', authorizedDate: '2026-07-03' }),
    );

    expect(result.reasons.dateScore).toBe(1);
    expect(result.reasons.dateBasis).toBe('authorized');
    expect(result.score).toBeGreaterThanOrEqual(AUTO_ATTACH_THRESHOLD);
  });
});

describe('decideMatch', () => {
  const scored = (over: Partial<ScoredCandidate> & { score: number }): ScoredCandidate => ({
    transaction: makeTransaction(),
    reasons: { dateScore: 1, cardScore: 0.5 },
    exactAmount: true,
    ...over,
  });

  it('attaches a unique exact-amount, in-window match even below the auto bar', () => {
    const decision = decideMatch([scored({ score: 0.8 })]);
    expect(decision?.attach).toBe(true);
  });

  it('does not attach when two candidates are essentially tied', () => {
    const decision = decideMatch([
      scored({ score: 0.86 }),
      scored({ score: 0.855 }),
    ]);
    expect(decision?.attach).toBe(false);
  });

  it('does not attach a unique match when the card contradicts', () => {
    const decision = decideMatch([
      scored({ score: 0.8, reasons: { dateScore: 1, cardScore: 0 } }),
    ]);
    expect(decision?.attach).toBe(false);
  });

  it('still attaches a high-confidence match above the auto bar', () => {
    const decision = decideMatch([scored({ score: 0.95, exactAmount: false })]);
    expect(decision?.attach).toBe(true);
  });

  it('returns null when nothing clears the suggested floor', () => {
    expect(decideMatch([scored({ score: 0.3 })])).toBeNull();
    expect(decideMatch([])).toBeNull();
  });

  it('annotates the best tied candidate as ambiguous instead of auto-safe', () => {
    const [best, second] = annotateCandidates([
      scored({ score: 0.86 }),
      scored({ score: 0.855, transaction: makeTransaction({ id: 't2' }) }),
    ]);
    expect(best.suggested).toBe(true);
    expect(best.ambiguous).toBe(true);
    expect(best.wouldAutoAttach).toBe(false);
    expect(second.suggested).toBe(false);
  });
});

const candidate = (over: Partial<ScoredCandidate> & { score: number }): ScoredCandidate => ({
  transaction: makeTransaction(),
  reasons: { dateScore: 1, cardScore: 0.5 },
  exactAmount: true,
  ...over,
});

describe('extraction-confidence gate', () => {
  it('only lets confident or user-entered details auto-attach', () => {
    expect(receiptAutoAttachEligible(makeReceipt({ confidence: '0.9' }))).toBe(true);
    // Regex fallback extractions land at 0.2–0.45.
    expect(receiptAutoAttachEligible(makeReceipt({ confidence: '0.45' }))).toBe(false);
    expect(receiptAutoAttachEligible(makeReceipt({ confidence: null }))).toBe(false);
    expect(receiptAutoAttachEligible({
      ...makeReceipt({ confidence: '0.2' }),
      userEditedFields: ['totalCents', 'receiptDate'],
    })).toBe(true);
    expect(receiptAutoAttachEligible({
      ...makeReceipt({ confidence: '0.2' }),
      userEditedFields: ['totalCents'],
    })).toBe(false);
    expect(receiptAutoAttachEligible(makeReceipt({ confidence: '0.95', receiptDate: null }))).toBe(false);
  });

  it('turns a low-confidence exact-unique match into a suggestion', () => {
    const scored = [candidate({ score: 0.8 })];
    expect(decideMatch(scored)?.attach).toBe(true);
    expect(decideMatch(scored, { allowAutoAttach: false })).toMatchObject({ attach: false });
    expect(planReceiptMatch(makeReceipt({ confidence: '0.45' }), scored).action).toBe('suggest');
    expect(planReceiptMatch(makeReceipt({ confidence: '0.9' }), scored).action).toBe('attach');
  });

  it('gates even high scores and keeps annotations consistent', () => {
    const scored = [candidate({ score: 0.97, exactAmount: false })];
    expect(planReceiptMatch(makeReceipt({ confidence: '0.3' }), scored).action).toBe('suggest');
    const [annotated] = annotateCandidates(scored, { allowAutoAttach: false });
    expect(annotated.suggested).toBe(true);
    expect(annotated.wouldAutoAttach).toBe(false);
  });
});

describe('stale suggestion cleanup', () => {
  it('plans a clear when a re-match finds nothing above the floor', () => {
    const receipt = makeReceipt({ confidence: '0.9' });
    expect(planReceiptMatch(receipt, [])).toEqual({ action: 'clear' });
    expect(planReceiptMatch(receipt, [candidate({ score: 0.3 })])).toEqual({ action: 'clear' });
  });
});

describe('receiptMatchSkipReason', () => {
  it('never lets the matcher touch dismissed or already-paired receipts', () => {
    expect(receiptMatchSkipReason(makeReceipt({ status: 'n/a' }))).toBe('not_pending');
    expect(receiptMatchSkipReason(makeReceipt({ status: 'matched' }))).toBe('already_matched');
    expect(receiptMatchSkipReason(makeReceipt({ transactionId: 't9' }))).toBe('already_matched');
    expect(receiptMatchSkipReason(makeReceipt({ totalCents: null }))).toBe('missing_details');
    expect(receiptMatchSkipReason(makeReceipt())).toBeNull();
  });
});

describe('detachedTransactionReceiptStatus', () => {
  it('falls back to what import would have assigned', () => {
    expect(detachedTransactionReceiptStatus(makeTransaction({ receiptStatus: 'matched' }), null)).toBe('missing');
    expect(detachedTransactionReceiptStatus(makeTransaction({ receiptStatus: 'matched' }), '2026-06-01')).toBe('waived');
    expect(detachedTransactionReceiptStatus(makeTransaction({ receiptStatus: 'matched', amountCents: 500 }), null)).toBe('n/a');
    expect(detachedTransactionReceiptStatus(makeTransaction({ receiptStatus: 'pending' }), null)).toBe('pending');
  });
});

describe('mergeUserEditedFields', () => {
  it('records only fields whose value changed, and keeps earlier edits', () => {
    const existing = { merchant: 'Sweetgreen', totalCents: 3821, receiptDate: '2026-05-22' };
    expect(mergeUserEditedFields([], existing, { merchant: 'Sweetgreen', totalCents: 3900, receiptDate: '2026-05-22' }))
      .toEqual(['totalCents']);
    expect(mergeUserEditedFields(['merchant'], existing, { receiptDate: '2026-05-23' }))
      .toEqual(['merchant', 'receiptDate']);
  });
});

/**
 * In-memory model of the two link columns (transactions.receipt_id / receipts.transaction_id).
 * Applying a plan exactly the way attachReceipt/unpairReceipt execute it must always leave the
 * links one-to-one and mutually consistent.
 */
interface World {
  transactions: Map<string, { id: string; receiptId: string | null; receiptStatus: 'matched' | 'missing' | 'pending' | 'n/a' | 'waived'; amountCents: number; date: string }>;
  receipts: Map<string, { id: string; transactionId: string | null; status: 'matched' | 'pending' | 'missing' | 'n/a' | 'waived' }>;
  rejected: Set<string>;
}

function world(links: Array<[receiptId: string, transactionId: string]>, extraTransactions: string[] = [], extraReceipts: string[] = []): World {
  const w: World = { transactions: new Map(), receipts: new Map(), rejected: new Set() };
  for (const id of extraTransactions) w.transactions.set(id, { id, receiptId: null, receiptStatus: 'missing', amountCents: -100, date: '2026-05-22' });
  for (const id of extraReceipts) w.receipts.set(id, { id, transactionId: null, status: 'pending' });
  for (const [r, t] of links) {
    w.transactions.set(t, { id: t, receiptId: r, receiptStatus: 'matched', amountCents: -100, date: '2026-05-22' });
    w.receipts.set(r, { id: r, transactionId: t, status: 'matched' });
  }
  return w;
}

function applyPlan(w: World, plan: PairingWritePlan) {
  for (const row of plan.detachTransactions) Object.assign(w.transactions.get(row.id)!, { receiptId: null, receiptStatus: row.receiptStatus });
  for (const id of plan.releaseReceiptIds) Object.assign(w.receipts.get(id)!, { transactionId: null, status: 'pending' });
  for (const pair of plan.rejectPairs) w.rejected.add(`${pair.receiptId}:${pair.transactionId}`);
}

function attach(w: World, receiptId: string, transactionId: string, mode: 'manual' | 'auto' = 'manual') {
  const receipt = w.receipts.get(receiptId)!;
  const transaction = w.transactions.get(transactionId)!;
  const plan = planAttach({
    receipt,
    transaction,
    receiptHolders: [...w.transactions.values()].filter((row) => row.receiptId === receiptId || row.id === receipt.transactionId),
    transactionReceipts: [...w.receipts.values()].filter((row) => row.transactionId === transactionId || row.id === transaction.receiptId),
    mode,
    receiptTrackingSince: null,
  });
  if (!plan.ok) return plan;
  applyPlan(w, plan);
  Object.assign(transaction, { receiptId, receiptStatus: 'matched' });
  Object.assign(receipt, { transactionId, status: 'matched' });
  return plan;
}

function unpair(w: World, receiptId: string) {
  const receipt = w.receipts.get(receiptId)!;
  const plan = planUnpair({
    receipt,
    receiptHolders: [...w.transactions.values()].filter((row) => row.receiptId === receiptId || row.id === receipt.transactionId),
    receiptTrackingSince: null,
  });
  applyPlan(w, plan);
  return plan;
}

function expectConsistent(w: World) {
  const holders = new Map<string, string>();
  for (const t of w.transactions.values()) {
    if (!t.receiptId) {
      expect(t.receiptStatus).not.toBe('matched');
      continue;
    }
    expect(holders.has(t.receiptId), `receipt ${t.receiptId} held twice`).toBe(false);
    holders.set(t.receiptId, t.id);
    expect(w.receipts.get(t.receiptId)?.transactionId).toBe(t.id);
  }
  for (const r of w.receipts.values()) {
    if (r.transactionId) expect(w.transactions.get(r.transactionId)?.receiptId).toBe(r.id);
    else expect(r.status).not.toBe('matched');
  }
}

describe('attach/unpair invariants', () => {
  it('moving a receipt to another transaction releases the old one and rejects that pair', () => {
    const w = world([['R', 'A']], ['B']);
    const plan = attach(w, 'R', 'B');
    expect(plan.ok).toBe(true);
    expect(w.transactions.get('A')).toMatchObject({ receiptId: null, receiptStatus: 'missing' });
    expect(w.rejected.has('R:A')).toBe(true);
    expectConsistent(w);
  });

  it('giving a transaction a new receipt returns the old receipt to the queue', () => {
    const w = world([['R0', 'T']], [], ['R']);
    attach(w, 'R', 'T');
    expect(w.receipts.get('R0')).toMatchObject({ transactionId: null, status: 'pending' });
    expect(w.rejected.has('R0:T')).toBe(true);
    expectConsistent(w);
  });

  it('repairs a receipt already held by two transactions', () => {
    const w = world([['R', 'A']], ['B', 'C']);
    w.transactions.get('B')!.receiptId = 'R'; // legacy duplicate the unique index now forbids
    w.transactions.get('B')!.receiptStatus = 'matched';
    attach(w, 'R', 'C');
    expectConsistent(w);
    expect(w.rejected).toEqual(new Set(['R:A', 'R:B']));
  });

  it('is a no-op when the pair already exists', () => {
    const w = world([['R', 'T']]);
    const plan = attach(w, 'R', 'T');
    expect(plan).toMatchObject({ ok: true, alreadyPaired: true, detachTransactions: [], releaseReceiptIds: [], rejectPairs: [] });
  });

  it('auto mode never steals or touches dismissed receipts', () => {
    const taken = world([['R', 'A']], ['B']);
    expect(attach(taken, 'R', 'B', 'auto')).toEqual({ ok: false, reason: 'receipt_not_pending' });
    const occupied = world([['R0', 'T']], [], ['R']);
    expect(attach(occupied, 'R', 'T', 'auto')).toEqual({ ok: false, reason: 'transaction_taken' });
    const dismissed = world([], ['T'], ['R']);
    dismissed.receipts.get('R')!.status = 'n/a';
    expect(attach(dismissed, 'R', 'T', 'auto')).toEqual({ ok: false, reason: 'receipt_not_pending' });
    const open = world([], ['T'], ['R']);
    expect(attach(open, 'R', 'T', 'auto')).toMatchObject({ ok: true });
    expectConsistent(open);
  });

  it('unpair resets both sides and remembers the rejection', () => {
    const w = world([['R', 'T']]);
    unpair(w, 'R');
    expect(w.transactions.get('T')).toMatchObject({ receiptId: null, receiptStatus: 'missing' });
    expect(w.receipts.get('R')).toMatchObject({ transactionId: null, status: 'pending' });
    expect(w.rejected.has('R:T')).toBe(true);
    expectConsistent(w);
  });

  it('unpairing an unpaired receipt changes nothing', () => {
    const w = world([], [], ['R']);
    expect(unpair(w, 'R')).toEqual({ detachTransactions: [], releaseReceiptIds: [], rejectPairs: [] });
  });

  it('survives a random sequence of pairs and unpairs', () => {
    const w = world([], ['T1', 'T2', 'T3'], ['R1', 'R2', 'R3']);
    let seed = 7;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let step = 0; step < 200; step += 1) {
      const r = `R${next(3) + 1}`;
      if (next(4) === 0) unpair(w, r);
      else attach(w, r, `T${next(3) + 1}`, next(2) === 0 ? 'auto' : 'manual');
      expectConsistent(w);
    }
  });
});
