// Receipt workflow client: match queue (1/2/3 pair, N dismiss, S skip), recently matched + undo,
// counts, "no receipt needed" rules, and per-transaction missing-receipt actions. Mock mode keeps
// a small in-memory world so the UI can be driven end to end without a backend.
import type { ReceiptInboxItem, Transaction } from '@/types/domain';
import type {
  CreateWaiverRuleInput,
  CreateWaiverRuleResult,
  ExplainedMatchCandidate,
  FindInGmailResult,
  MatchQueueItem,
  MatchQueuePage,
  MatchQueueParams,
  MatchQueueStep,
  MatchReason,
  RecentMatch,
  RecentMatchesParams,
  ReceiptWaiverRule,
  ReceiptWorkflowCounts,
  ThresholdRuleInput,
  UploadToTransactionResult,
  WaiveTransactionInput,
  WaiveTransactionResult,
  WaiverApplyPreview,
  WaiverEvidence,
} from '@/types/receiptWorkflow';
import { http, useMockApi } from './client';
import { mapTransaction, type ApiTransaction } from './mapper';

// ---------------------------------------------------------------------------------------------
// Wire shapes (transactions arrive in cents; mapTransaction adds display fields)
// ---------------------------------------------------------------------------------------------

/** Same shape as `T` but with its `transaction` field still in wire (cents) form. */
type WithApiTransaction<T extends { transaction: unknown }> = Omit<T, 'transaction'> & {
  transaction: null extends T['transaction'] ? ApiTransaction | null : ApiTransaction;
};

type ApiCandidate = Omit<ExplainedMatchCandidate, 'transaction'> & { transaction: ApiTransaction };
type ApiQueueItem = Omit<MatchQueueItem, 'candidates'> & { candidates: ApiCandidate[] };

function mapCandidate(row: ApiCandidate): ExplainedMatchCandidate {
  return { ...row, transaction: mapTransaction(row.transaction) };
}

function mapQueueItem(row: ApiQueueItem): MatchQueueItem {
  return { ...row, candidates: row.candidates.map(mapCandidate) };
}

function mapMaybeTransaction(row: ApiTransaction | null | undefined): Transaction | null {
  return row ? mapTransaction(row) : null;
}

function query(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === 'all') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

// ---------------------------------------------------------------------------------------------
// Mock world
// ---------------------------------------------------------------------------------------------

function mockTxn(id: string, merchant: string, amountCents: number, date: string, receipt: Transaction['receipt'] = 'missing'): Transaction {
  return mapTransaction({
    id,
    date,
    merchant,
    amountCents,
    biz: 'draft-sharks',
    cat: 'Software',
    receipt,
    src: 'Amex •• 4002',
    tags: [],
  });
}

function mockReceipt(id: string, merchant: string, totalCents: number | null, receiptDate: string | null, source: ReceiptInboxItem['source'] = 'gmail'): ReceiptInboxItem {
  const now = new Date().toISOString();
  return {
    id,
    biz: 'draft-sharks',
    businessName: 'Draft Sharks',
    source,
    status: 'pending',
    merchant,
    totalCents,
    receiptDate,
    fileName: `${merchant.toLowerCase().replace(/\W+/g, '-')}.pdf`,
    confidence: totalCents == null ? null : 0.9,
    extractionError: totalCents == null ? 'Could not read the receipt total — add it manually to enable matching.' : null,
    createdAt: now,
    updatedAt: now,
  };
}

const reason = (kind: MatchReason['kind'], text: string, strength: MatchReason['strength'], score: number): MatchReason => ({ kind, text, strength, score });

function mockCandidate(transaction: Transaction, score: number, explanations: MatchReason[], suggested = false): ExplainedMatchCandidate {
  return {
    transaction,
    score,
    reasons: Object.fromEntries(explanations.map((row) => [`${row.kind}Score`, row.score])),
    explanations,
    exactAmount: explanations.some((row) => row.text === 'Amount exact'),
    ambiguous: false,
    suggested,
    wouldAutoAttach: false,
    rejected: false,
  };
}

const mock = (() => {
  const adobe = mockTxn('txn-adobe', 'ADOBE *CREATIVE CLD', -5499, '2026-09-10');
  const adobe2 = mockTxn('txn-adobe-2', 'ADOBE *ACROPRO', -2399, '2026-09-11');
  const figma = mockTxn('txn-figma', 'FIGMA', -1500, '2026-09-12');
  const uber = mockTxn('txn-uber', 'UBER *TRIP', -3218, '2026-09-14');
  const hotel = mockTxn('txn-hotel', 'MARRIOTT AUSTIN', -41200, '2026-09-15');
  const matched = mockTxn('txn-notion', 'NOTION LABS', -1000, '2026-09-20', 'matched');
  const queue: MatchQueueItem[] = [
    {
      receipt: mockReceipt('rcpt-adobe', 'Adobe', 5499, '2026-09-10'),
      blockedReason: null,
      candidates: [
        mockCandidate(adobe, 0.93, [
          reason('amount', 'Amount exact', 'strong', 1),
          reason('date', 'Same day', 'strong', 1),
          reason('merchant', '"Adobe" ≈ "ADOBE *CREATIVE CLD"', 'strong', 0.9),
          reason('card', 'Card ••4002 matches', 'strong', 1),
        ], true),
        mockCandidate(adobe2, 0.52, [
          reason('amount', 'Amount off by $31.00 (receipt higher)', 'conflict', 0),
          reason('date', '1 day apart', 'strong', 1),
          reason('merchant', '"Adobe" ≈ "ADOBE *ACROPRO"', 'strong', 0.9),
        ]),
      ],
    },
    {
      receipt: mockReceipt('rcpt-uber', 'Uber', 3258, '2026-09-13', 'upload'),
      blockedReason: null,
      candidates: [
        mockCandidate(uber, 0.71, [
          reason('amount', 'Amount off by $0.40 (receipt higher)', 'good', 0.6),
          reason('date', '1 day apart', 'strong', 1),
          reason('merchant', 'Merchant "Uber" matches', 'strong', 1),
          reason('card', 'Different card ••1111 (charged to ••4002)', 'conflict', 0),
        ], true),
      ],
    },
    { receipt: mockReceipt('rcpt-blurry', 'Unknown', null, '2026-09-16', 'upload'), blockedReason: 'missing_details', candidates: [] },
  ];
  const recent: RecentMatch[] = [{
    matchId: 'match-notion',
    mode: 'auto',
    matchedAt: new Date(Date.now() - 3_600_000).toISOString(),
    score: 0.97,
    receipt: { ...mockReceipt('rcpt-notion', 'Notion Labs, Inc.', 1000, '2026-09-20'), status: 'matched', transactionId: matched.id },
    transaction: matched,
    explanations: [
      reason('amount', 'Amount exact', 'strong', 1),
      reason('date', 'Same day', 'strong', 1),
      reason('merchant', '"Notion Labs, Inc." ≈ "NOTION LABS"', 'strong', 0.9),
    ],
  }];
  const rules: ReceiptWaiverRule[] = [{
    id: 'rule-threshold',
    kind: 'threshold',
    enabled: false,
    label: 'Under $75.00 (lodging excluded)',
    businessId: null,
    thresholdCents: 7500,
    excludeLodging: true,
    merchantPattern: null,
    merchantLabel: null,
    categoryId: null,
    categoryName: null,
    note: 'IRS: receipts generally not required for expenses under $75 (lodging excepted)',
    waivedCount: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  }];
  const missing = [adobe, adobe2, figma, uber, hotel];
  const waivers = new Map<string, WaiverEvidence>();
  return { queue, recent, rules, missing, waivers, skipped: new Set<string>() };
})();

function mockQueuePage(params: MatchQueueParams = {}): MatchQueuePage {
  const skip = new Set(params.skip ?? []);
  const rows = mock.queue.filter((item) => !skip.has(item.receipt.id));
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 10;
  const items = rows.slice(offset, offset + limit);
  return { items, total: rows.length, nextOffset: offset + items.length < rows.length ? offset + items.length : null };
}

function mockStep(receiptId: string, skip: string[] = [], transaction?: Transaction): MatchQueueStep {
  const index = mock.queue.findIndex((item) => item.receipt.id === receiptId);
  const [removed] = index >= 0 ? mock.queue.splice(index, 1) : [];
  const page = mockQueuePage({ skip: [...skip, receiptId], limit: 1 });
  return {
    receipt: removed ? { ...removed.receipt, status: transaction ? 'matched' : 'n/a', transactionId: transaction?.id ?? null } : null,
    transaction: transaction ?? null,
    next: page.items[0] ?? null,
    remaining: page.total,
  };
}

const delay = <T,>(value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), 120));

// ---------------------------------------------------------------------------------------------
// Match queue
// ---------------------------------------------------------------------------------------------

/** GET /receipts/queue — unmatched receipts, each with its top 3 candidates + reasons. */
export function getMatchQueue(params: MatchQueueParams = {}): Promise<MatchQueuePage> {
  if (useMockApi) return delay(mockQueuePage(params));
  return http<{ items: ApiQueueItem[]; total: number; nextOffset: number | null }>(`/receipts/queue${query({
    limit: params.limit,
    offset: params.offset,
    skip: params.skip?.join(','),
    biz: params.biz,
    order: params.order,
  })}`).then((page) => ({ ...page, items: page.items.map(mapQueueItem) }));
}

type ApiStep = { receipt: ReceiptInboxItem | null; transaction?: ApiTransaction | null; next: ApiQueueItem | null; remaining: number };

function mapStep(step: ApiStep): MatchQueueStep {
  return {
    receipt: step.receipt,
    transaction: mapMaybeTransaction(step.transaction),
    next: step.next ? mapQueueItem(step.next) : null,
    remaining: step.remaining,
  };
}

/** POST /receipts/queue/:id/pair — keys 1/2/3. Returns the next queue item. */
export function pairFromQueue(receiptId: string, transactionId: string, options: { skip?: string[]; biz?: string } = {}): Promise<MatchQueueStep> {
  if (useMockApi) {
    const item = mock.queue.find((row) => row.receipt.id === receiptId);
    const candidate = item?.candidates.find((row) => row.transaction.id === transactionId);
    const transaction = candidate ? { ...candidate.transaction, receipt: 'matched' as const, receiptId } : undefined;
    if (item && transaction) {
      mock.recent.unshift({
        matchId: `match-${receiptId}`,
        mode: 'manual',
        matchedAt: new Date().toISOString(),
        score: candidate!.score,
        receipt: { ...item.receipt, status: 'matched', transactionId },
        transaction,
        explanations: candidate!.explanations,
      });
    }
    return delay(mockStep(receiptId, options.skip, transaction));
  }
  return http<ApiStep>(`/receipts/queue/${receiptId}/pair`, json({ transactionId, skip: options.skip ?? [], biz: options.biz })).then(mapStep);
}

/** POST /receipts/queue/:id/dismiss — key N (not a business receipt). Returns the next queue item. */
export function dismissFromQueue(receiptId: string, options: { skip?: string[]; biz?: string } = {}): Promise<MatchQueueStep> {
  if (useMockApi) return delay(mockStep(receiptId, options.skip));
  return http<ApiStep>(`/receipts/queue/${receiptId}/dismiss`, json({ skip: options.skip ?? [], biz: options.biz })).then(mapStep);
}

// ---------------------------------------------------------------------------------------------
// Recently matched + undo
// ---------------------------------------------------------------------------------------------

/** GET /receipts/recent-matches — live auto/manual pairs from the last N days (default 7). */
export function listRecentMatches(params: RecentMatchesParams = {}): Promise<{ items: RecentMatch[]; total: number }> {
  if (useMockApi) {
    const items = mock.recent.filter((row) => !params.mode || params.mode === 'all' || row.mode === params.mode);
    return delay({ items, total: items.length });
  }
  return http<{ items: Array<WithApiTransaction<RecentMatch>>; total: number }>(`/receipts/recent-matches${query({ ...params })}`)
    .then((page) => ({
      total: page.total,
      items: page.items.map((row) => ({ ...row, transaction: mapTransaction(row.transaction) })),
    }));
}

/** Undo a pairing (POST /receipts/:id/unpair): both sides reopen and the pair is never auto-proposed again. */
export function undoMatch(receiptId: string): Promise<ReceiptInboxItem> {
  if (useMockApi) {
    const index = mock.recent.findIndex((row) => row.receipt.id === receiptId);
    const [removed] = index >= 0 ? mock.recent.splice(index, 1) : [];
    return delay({ ...(removed?.receipt ?? mockReceipt(receiptId, 'Receipt', null, null)), status: 'pending', transactionId: null });
  }
  return http<ReceiptInboxItem>(`/receipts/${receiptId}/unpair`, { method: 'POST' });
}

// ---------------------------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------------------------

/** GET /receipts/counts — badge numbers for the receipts workspace. */
export function getReceiptWorkflowCounts(params: { biz?: string } = {}): Promise<ReceiptWorkflowCounts> {
  if (useMockApi) {
    const missing = mock.missing.filter((row) => row.receipt === 'missing');
    const waived = [...mock.waivers.keys()].length;
    return delay({
      unmatchedReceipts: mock.queue.length,
      missingReceipts: { count: missing.length, cents: missing.reduce((sum, row) => sum + Math.abs(row.amountCents ?? 0), 0) },
      waivedThisMonth: { count: waived, cents: 0 },
      autoMatchedThisWeek: mock.recent.filter((row) => row.mode === 'auto').length,
    });
  }
  return http<ReceiptWorkflowCounts>(`/receipts/counts${query(params)}`);
}

// ---------------------------------------------------------------------------------------------
// "No receipt needed" rules
// ---------------------------------------------------------------------------------------------

/** GET /receipts/waiver-rules */
export function listWaiverRules(): Promise<ReceiptWaiverRule[]> {
  if (useMockApi) return delay([...mock.rules]);
  return http<{ rules: ReceiptWaiverRule[] }>('/receipts/waiver-rules').then((body) => body.rules);
}

/** PUT /receipts/waiver-rules/threshold — the global "under $X" rule (seeded off at $75). */
export function updateThresholdRule(input: ThresholdRuleInput): Promise<ReceiptWaiverRule> {
  if (useMockApi) {
    const rule = mock.rules.find((row) => row.kind === 'threshold')!;
    Object.assign(rule, input, {
      label: `Under $${((input.thresholdCents ?? rule.thresholdCents ?? 7500) / 100).toFixed(2)}${(input.excludeLodging ?? rule.excludeLodging) ? ' (lodging excluded)' : ''}`,
      updatedAt: new Date().toISOString(),
    });
    return delay({ ...rule });
  }
  return http<ReceiptWaiverRule>('/receipts/waiver-rules/threshold', { method: 'PUT', body: JSON.stringify(input) });
}

/** POST /receipts/waiver-rules — a merchant or category rule. */
export function createWaiverRule(input: CreateWaiverRuleInput): Promise<CreateWaiverRuleResult> {
  if (useMockApi) {
    const now = new Date().toISOString();
    const rule: ReceiptWaiverRule = {
      id: `rule-${mock.rules.length + 1}`,
      kind: input.kind,
      enabled: true,
      label: input.kind === 'merchant' ? `Merchant: ${input.merchant}` : 'Category: Software',
      businessId: input.kind === 'merchant' ? input.businessId ?? null : null,
      thresholdCents: null,
      excludeLodging: true,
      merchantPattern: input.kind === 'merchant' ? input.merchant.toLowerCase().replace(/[^a-z]/g, '') : null,
      merchantLabel: input.kind === 'merchant' ? input.merchant : null,
      categoryId: input.kind === 'category' ? input.categoryId : null,
      categoryName: input.kind === 'category' ? 'Software' : null,
      note: input.note ?? null,
      waivedCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    mock.rules.push(rule);
    return delay({ rule, created: true, waived: 0 });
  }
  return http<CreateWaiverRuleResult>('/receipts/waiver-rules', json(input));
}

/** PATCH /receipts/waiver-rules/:id — enable/disable or edit the note. */
export function updateWaiverRule(ruleId: string, patch: { enabled?: boolean; note?: string | null }): Promise<ReceiptWaiverRule> {
  if (useMockApi) {
    const rule = mock.rules.find((row) => row.id === ruleId) ?? mock.rules[0];
    Object.assign(rule, patch, { updatedAt: new Date().toISOString() });
    return delay({ ...rule });
  }
  return http<ReceiptWaiverRule>(`/receipts/waiver-rules/${ruleId}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

/**
 * DELETE /receipts/waiver-rules/:id — `reopen: true` puts the rule's waived transactions
 * (rule.waivedCount of them) back to missing. The threshold rule can only be disabled.
 */
export function deleteWaiverRule(ruleId: string, options: { reopen?: boolean } = {}): Promise<{ deleted: boolean; reopened: number }> {
  if (useMockApi) {
    const index = mock.rules.findIndex((row) => row.id === ruleId && row.kind !== 'threshold');
    const [removed] = index >= 0 ? mock.rules.splice(index, 1) : [];
    return delay({ deleted: Boolean(removed), reopened: options.reopen ? removed?.waivedCount ?? 0 : 0 });
  }
  return http<{ deleted: boolean; reopened: number }>(`/receipts/waiver-rules/${ruleId}${query({ reopen: options.reopen ? 'true' : undefined })}`, { method: 'DELETE' });
}

/** GET /receipts/waiver-rules/apply-preview — how many missing-receipt transactions the rules would waive. */
export function previewApplyWaivers(ruleId?: string): Promise<WaiverApplyPreview> {
  if (useMockApi) {
    const threshold = mock.rules.find((row) => row.kind === 'threshold');
    const hits = threshold?.enabled
      ? mock.missing.filter((row) => row.receipt === 'missing' && Math.abs(row.amountCents ?? 0) < (threshold.thresholdCents ?? 7500) && !/marriott/i.test(row.merchant))
      : [];
    const totalCents = hits.reduce((sum, row) => sum + Math.abs(row.amountCents ?? 0), 0);
    return delay({
      count: hits.length,
      totalCents,
      byRule: hits.length && threshold ? [{ ruleId: threshold.id, kind: 'threshold', label: threshold.label, count: hits.length, totalCents }] : [],
      sampleTransactionIds: hits.map((row) => row.id).slice(0, 10),
    });
  }
  return http<WaiverApplyPreview>(`/receipts/waiver-rules/apply-preview${query({ ruleId })}`);
}

/** POST /receipts/waiver-rules/apply — waive every existing missing transaction the rules cover. */
export async function applyWaivers(ruleId?: string): Promise<{ waived: number }> {
  if (useMockApi) {
    const preview = await previewApplyWaivers(ruleId);
    for (const id of preview.sampleTransactionIds) {
      const row = mock.missing.find((txn) => txn.id === id);
      if (row) row.receipt = 'waived';
      mock.waivers.set(id, { kind: 'threshold', ruleId: preview.byRule[0]?.ruleId ?? null, label: preview.byRule[0]?.label ?? 'Under $75.00', note: null, createdAt: new Date().toISOString() });
    }
    return { waived: preview.count };
  }
  return http<{ waived: number }>('/receipts/waiver-rules/apply', json({ ruleId }));
}

// ---------------------------------------------------------------------------------------------
// Missing-receipt actions on one transaction
// ---------------------------------------------------------------------------------------------

/** POST /transactions/:id/receipt/upload — attach a file directly to this transaction (manual pair). */
export function uploadReceiptToTransaction(transactionId: string, file: File): Promise<UploadToTransactionResult> {
  if (useMockApi) {
    const row = mock.missing.find((txn) => txn.id === transactionId);
    if (row) row.receipt = 'matched';
    const receipt = { ...mockReceipt(`rcpt-${transactionId}`, file.name, null, null, 'upload'), status: 'matched' as const, transactionId, extractionError: null };
    return delay({ transaction: row ?? null, receipt, processing: true });
  }
  const form = new FormData();
  form.append('file', file);
  return http<WithApiTransaction<UploadToTransactionResult>>(`/transactions/${transactionId}/receipt/upload`, { method: 'POST', body: form })
    .then((body) => ({ ...body, transaction: mapMaybeTransaction(body.transaction) }));
}

/** POST /transactions/:id/receipt/find-in-gmail — search connected mailboxes for this charge's receipt. */
export function findReceiptInGmail(transactionId: string): Promise<FindInGmailResult> {
  if (useMockApi) {
    const transaction = mock.missing.find((txn) => txn.id === transactionId) ?? mock.missing[0];
    const found = transaction.id === 'txn-figma';
    if (found) transaction.receipt = 'matched';
    return delay({
      search: {
        query: 'after:2026/09/05 before:2026/09/20 ("15.00" OR (figma (receipt OR invoice OR order OR payment OR billing OR subscription)))',
        merchantTerms: ['figma'],
        amountVariants: ['15.00'],
        from: '2026-09-05',
        to: '2026-09-19',
      },
      searchable: true,
      mailboxes: [{ connectionId: 'gmail-1', email: 'owner@example.com', messagesFound: found ? 1 : 0, newReceipts: found ? 1 : 0, error: null }],
      hits: found
        ? [{
          receipt: { ...mockReceipt('rcpt-figma', 'Figma', 1500, '2026-09-12'), status: 'matched', transactionId: transaction.id },
          status: 'paired_here',
          isNew: true,
          score: 0.95,
          explanations: [reason('amount', 'Amount exact', 'strong', 1), reason('date', 'Same day', 'strong', 1), reason('merchant', 'Merchant "Figma" matches', 'strong', 1)],
        }]
        : [],
      paired: found,
      transaction: { ...transaction },
    });
  }
  return http<WithApiTransaction<FindInGmailResult>>(`/transactions/${transactionId}/receipt/find-in-gmail`, { method: 'POST' })
    .then((body) => ({ ...body, transaction: mapTransaction(body.transaction) }));
}

/** POST /transactions/:id/receipt/waive — "no receipt needed", optionally always for this merchant. */
export function waiveReceipt(transactionId: string, input: WaiveTransactionInput = {}): Promise<WaiveTransactionResult> {
  if (useMockApi) {
    const row = mock.missing.find((txn) => txn.id === transactionId);
    if (row) row.receipt = 'waived';
    mock.waivers.set(transactionId, {
      kind: input.alwaysForMerchant ? 'merchant' : 'manual',
      ruleId: null,
      label: input.alwaysForMerchant ? `Merchant: ${row?.merchant ?? 'merchant'}` : 'Marked "no receipt needed"',
      note: input.note ?? null,
      createdAt: new Date().toISOString(),
    });
    return delay({ transaction: row ?? null, rule: null, alsoWaived: 0 });
  }
  return http<WithApiTransaction<WaiveTransactionResult>>(`/transactions/${transactionId}/receipt/waive`, json(input))
    .then((body) => ({ ...body, transaction: mapMaybeTransaction(body.transaction) }));
}

/** DELETE /transactions/:id/receipt/waiver — undo a waiver (back to missing). */
export function unwaiveReceipt(transactionId: string): Promise<Transaction | null> {
  if (useMockApi) {
    const row = mock.missing.find((txn) => txn.id === transactionId);
    if (row) row.receipt = 'missing';
    mock.waivers.delete(transactionId);
    return delay(row ?? null);
  }
  return http<{ transaction: ApiTransaction | null }>(`/transactions/${transactionId}/receipt/waiver`, { method: 'DELETE' })
    .then((body) => mapMaybeTransaction(body.transaction));
}

/** GET /transactions/:id/receipt/waiver — why this transaction needs no receipt (null if not waived). */
export function getWaiverEvidence(transactionId: string): Promise<WaiverEvidence | null> {
  if (useMockApi) return delay(mock.waivers.get(transactionId) ?? null);
  return http<{ evidence: WaiverEvidence | null }>(`/transactions/${transactionId}/receipt/waiver`).then((body) => body.evidence);
}
