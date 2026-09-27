import { describe, expect, it, vi } from 'vitest';
import {
  QboApiClient,
  QboReauthRequiredError,
  ensureFreshAccessToken,
  parseCdcResponse,
  type QboConfig,
  type QboTokenSet,
} from './quickbooksClient.js';
import { normalizeAccount, normalizeTransaction, normalizeVendor, attachableTransactionRef } from './quickbooksNormalize.js';
import { autoLinkIsStale, linkWindow, planAutoLinks, type LinkCandidateTxn, type LinkLeg } from './quickbooksLinking.js';
import {
  buildContractorReport,
  classifyContractor,
  isContractLaborAccount,
  necThreshold,
  type ContractorPaymentInput,
} from './quickbooksContractors.js';
import { chooseSyncMode, decideAttachmentImport, fullSyncWhere, historyStartDate } from './quickbooksSync.js';
import { scoreCategoryMatch, suggestCategory, suggestLedgerAccounts } from './quickbooksMapping.js';
import { computeCategorySuggestion, type CategoryMappingLite } from './quickbooks.js';

const config: QboConfig = {
  clientId: 'cid',
  clientSecret: 'secret',
  redirectUri: 'http://localhost/cb',
  environment: 'sandbox',
  apiBase: 'http://qbo.test',
  authorizeUrl: 'http://auth.test/connect/oauth2',
  tokenUrl: 'http://auth.test/token',
  revokeUrl: 'http://auth.test/revoke',
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

describe('QuickBooks token refresh', () => {
  const now = new Date('2026-09-27T12:00:00Z');
  const stale: QboTokenSet = {
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    accessTokenExpiresAt: new Date(now.getTime() + 60_000),
    refreshTokenExpiresAt: null,
  };

  it('refreshes a near-expiry token and persists the ROTATED refresh token', async () => {
    const persisted: QboTokenSet[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(String(init?.body)).toContain('grant_type=refresh_token');
      expect(String(init?.body)).toContain('refresh_token=old-refresh');
      expect((init?.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('cid:secret').toString('base64')}`);
      return jsonResponse(200, { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, x_refresh_token_expires_in: 8726400 });
    });
    const token = await ensureFreshAccessToken(config, {
      load: async () => stale,
      persist: async (t) => { persisted.push(t); },
    }, { fetchImpl, now });
    expect(token).toBe('new-access');
    expect(persisted).toHaveLength(1);
    expect(persisted[0].refreshToken).toBe('new-refresh');
    expect(persisted[0].accessTokenExpiresAt.toISOString()).toBe('2026-09-27T13:00:00.000Z');
    expect(persisted[0].refreshTokenExpiresAt?.getTime()).toBe(now.getTime() + 8726400 * 1000);
  });

  it('uses the stored token while it is fresh, and refreshes when forced', async () => {
    const fresh = { ...stale, accessTokenExpiresAt: new Date(now.getTime() + 30 * 60_000) };
    const fetchImpl = vi.fn(async () => jsonResponse(200, { access_token: 'forced', refresh_token: 'r2', expires_in: 3600 }));
    const persist = vi.fn(async () => undefined);
    expect(await ensureFreshAccessToken(config, { load: async () => fresh, persist }, { fetchImpl, now })).toBe('old-access');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await ensureFreshAccessToken(config, { load: async () => fresh, persist }, { fetchImpl, now, force: true })).toBe('forced');
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('turns invalid_grant into a re-auth error without persisting anything', async () => {
    const persist = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async () => jsonResponse(400, { error: 'invalid_grant' }));
    await expect(ensureFreshAccessToken(config, { load: async () => stale, persist }, { fetchImpl, now }))
      .rejects.toBeInstanceOf(QboReauthRequiredError);
    expect(persist).not.toHaveBeenCalled();
  });
});

describe('QuickBooks API client', () => {
  function client(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, getAccessToken = vi.fn(async () => 'tok')) {
    const sleep = vi.fn(async () => undefined);
    return {
      api: new QboApiClient({ realmId: '123', apiBase: 'http://qbo.test', getAccessToken, fetchImpl, sleep, minIntervalMs: 0 }),
      sleep,
      getAccessToken,
    };
  }

  it('pages queries with STARTPOSITION / MAXRESULTS 1000 until a short page', async () => {
    const urls: string[] = [];
    const { api } = client(async (url) => {
      urls.push(decodeURIComponent(url));
      const start = Number(decodeURIComponent(url).match(/STARTPOSITION (\d+)/)![1]);
      const count = start === 1 ? 1000 : 3;
      return jsonResponse(200, { QueryResponse: { Purchase: Array.from({ length: count }, (_, i) => ({ Id: String(start + i) })) } });
    });
    const items = await api.queryAll('Purchase', "TxnDate >= '2024-09-01'");
    expect(items).toHaveLength(1003);
    expect(urls[0]).toContain("SELECT * FROM Purchase WHERE TxnDate >= '2024-09-01' STARTPOSITION 1 MAXRESULTS 1000");
    expect(urls[1]).toContain('STARTPOSITION 1001 MAXRESULTS 1000');
    expect(urls[0]).toContain('minorversion=75');
    expect(urls[0]).toContain('/v3/company/123/query');
  });

  it('treats an empty QueryResponse as no rows', async () => {
    const { api } = client(async () => jsonResponse(200, { QueryResponse: {} }));
    expect(await api.queryAll('Vendor')).toEqual([]);
  });

  it('backs off on 429 using Retry-After, then succeeds', async () => {
    let calls = 0;
    const { api, sleep } = client(async () => {
      calls += 1;
      return calls === 1 ? jsonResponse(429, { Fault: {} }, { 'Retry-After': '2' }) : jsonResponse(200, { CompanyInfo: { CompanyName: 'X' } });
    });
    expect((await api.companyInfo())?.CompanyName).toBe('X');
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('forces one token refresh on 401 and retries', async () => {
    let calls = 0;
    const getAccessToken = vi.fn(async (force: boolean) => (force ? 'fresh' : 'tok'));
    const { api } = client(async () => {
      calls += 1;
      return calls === 1 ? jsonResponse(401, { Fault: { Error: [{ Message: 'AuthenticationFailed' }] } }) : jsonResponse(200, { CompanyInfo: {} });
    }, getAccessToken);
    await api.companyInfo();
    expect(getAccessToken).toHaveBeenCalledWith(true);
  });
});

describe('CDC parsing', () => {
  it('collects entities across QueryResponse entries, including deletions', () => {
    const parsed = parseCdcResponse({
      CDCResponse: [{
        QueryResponse: [
          { Purchase: [{ Id: '1', TotalAmt: 5 }, { Id: '2', status: 'Deleted', MetaData: { LastUpdatedTime: '2026-09-01T00:00:00Z' } }], startPosition: 1, maxResults: 2 },
          { Vendor: [{ Id: '9' }] },
          {},
        ],
      }],
      time: '2026-09-27T00:00:00Z',
    }, ['Purchase', 'Vendor', 'Bill']);
    expect(parsed.entities.get('Purchase')).toHaveLength(2);
    expect(parsed.entities.get('Purchase')![1].status).toBe('Deleted');
    expect(parsed.entities.get('Vendor')).toHaveLength(1);
    expect(parsed.entities.get('Bill')).toEqual([]);
    expect(parsed.time).toBe('2026-09-27T00:00:00Z');
  });

  it('chooses full vs CDC by the 30-day CDC window', () => {
    const now = new Date('2026-09-27T00:00:00Z');
    expect(chooseSyncMode({ lastCdcAt: null, lastFullSyncAt: null }, now)).toBe('full');
    expect(chooseSyncMode({ lastCdcAt: new Date('2026-09-20T00:00:00Z'), lastFullSyncAt: new Date('2026-01-01') }, now)).toBe('cdc');
    expect(chooseSyncMode({ lastCdcAt: new Date('2026-08-01T00:00:00Z'), lastFullSyncAt: new Date('2026-01-01') }, now)).toBe('full');
    expect(chooseSyncMode({ lastCdcAt: new Date('2026-09-26T00:00:00Z'), lastFullSyncAt: new Date('2026-01-01'), forceFull: true }, now)).toBe('full');
    expect(historyStartDate(now)).toBe('2024-09-01');
    expect(fullSyncWhere('Vendor', '2024-09-01')).toBe('Active IN (true, false)');
    expect(fullSyncWhere('Purchase', '2024-09-01')).toBe("TxnDate >= '2024-09-01'");
  });
});

describe('entity normalization', () => {
  it('signs purchase legs like Ledger (money out negative; credits positive)', () => {
    const check = normalizeTransaction('Purchase', {
      Id: '1', PaymentType: 'Check', DocNumber: '1042', TxnDate: '2026-03-02', TotalAmt: 1500.5,
      AccountRef: { value: '35', name: 'Checking' }, EntityRef: { value: '56', name: 'Jane', type: 'Vendor' },
      Line: [{ Amount: 1500.5, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: '60', name: 'Contract Labor' } } }],
    });
    expect(check.paymentMethod).toBe('check');
    expect(check.legs).toEqual([{ leg: 'main', accountQboId: '35', amountCents: -150050 }]);
    expect(check.lines[0]).toMatchObject({ accountQboId: '60', amountCents: 150050 });
    expect(check.vendorQboId).toBe('56');

    const refund = normalizeTransaction('Purchase', { Id: '2', PaymentType: 'CreditCard', Credit: true, TxnDate: '2026-05-20', TotalAmt: 50, AccountRef: { value: '41' } });
    expect(refund.legs[0].amountCents).toBe(5000);
    expect(refund.paymentMethod).toBe('credit_card');

    const ach = normalizeTransaction('Purchase', { Id: '3', PaymentType: 'Cash', TxnDate: '2026-05-20', TotalAmt: 9, AccountRef: { value: '35' }, EntityRef: { value: '7', type: 'Employee' } });
    expect(ach.paymentMethod).toBe('cash_ach');
    expect(ach.vendorQboId).toBeNull();
  });

  it('handles bill payments, deposits, transfers and bills', () => {
    const bp = normalizeTransaction('BillPayment', {
      Id: '3', PayType: 'CreditCard', TxnDate: '2026-08-20', TotalAmt: 1300, VendorRef: { value: '57' },
      CreditCardPayment: { CCAccountRef: { value: '41' } }, Line: [{ Amount: 1300, LinkedTxn: [{ TxnId: '2001', TxnType: 'Bill' }] }],
    });
    expect(bp.legs).toEqual([{ leg: 'main', accountQboId: '41', amountCents: -130000 }]);
    expect(bp.linkedTxns).toEqual([{ txnId: '2001', txnType: 'Bill' }]);
    const dep = normalizeTransaction('Deposit', { Id: '4', TxnDate: '2026-06-30', TotalAmt: 120, DepositToAccountRef: { value: '35' } });
    expect(dep.legs[0].amountCents).toBe(12000);
    const tr = normalizeTransaction('Transfer', { Id: '5', TxnDate: '2026-07-15', Amount: 50, FromAccountRef: { value: '35' }, ToAccountRef: { value: '36', name: 'Savings' } });
    expect(tr.legs).toEqual([{ leg: 'from', accountQboId: '35', amountCents: -5000 }, { leg: 'to', accountQboId: '36', amountCents: 5000 }]);
    const bill = normalizeTransaction('Bill', { Id: '6', TxnDate: '2026-08-01', TotalAmt: 10, VendorRef: { value: '57' } });
    expect(bill.legs).toEqual([]);
  });

  it('never keeps the tax ID, only whether one is on file', () => {
    const vendor = normalizeVendor({ Id: '56', DisplayName: 'Jane', Vendor1099: true, TaxIdentifier: 'XXX-XX-1234' });
    expect(vendor).toMatchObject({ vendor1099: true, hasTaxId: true });
    expect(JSON.stringify(vendor)).not.toContain('1234');
    expect(normalizeVendor({ Id: '1', DisplayName: 'X' }).hasTaxId).toBe(false);
  });

  it('extracts account last-4 from AcctNum or the name', () => {
    expect(normalizeAccount({ Id: '1', Name: 'Chase', AcctNum: '000123456789', AccountType: 'Bank' }).acctNumLast4).toBe('6789');
    expect(normalizeAccount({ Id: '2', Name: 'Amex ...1005', AccountType: 'Credit Card' }).acctNumLast4).toBe('1005');
    expect(normalizeAccount({ Id: '3', Name: 'Petty cash', AccountType: 'Bank' }).acctNumLast4).toBeNull();
  });

  it('finds the transaction an attachable belongs to', () => {
    expect(attachableTransactionRef([{ type: 'Vendor', value: '1' }, { type: 'Purchase', value: '9' }])).toEqual({ type: 'Purchase', value: '9' });
    expect(attachableTransactionRef([{ type: 'Vendor', value: '1' }])).toBeNull();
  });
});

describe('QBO ↔ Ledger link planning', () => {
  const leg = (overrides: Partial<LinkLeg> = {}): LinkLeg => ({
    qboTransactionId: 'q1', leg: 'main', ledgerAccountId: 'acct', amountCents: -1500, txnDate: '2026-03-02', paymentMethod: 'cash_ach', docNumber: null, ...overrides,
  });
  const txn = (id: string, overrides: Partial<LinkCandidateTxn> = {}): LinkCandidateTxn => ({
    id, accountId: 'acct', amountCents: -1500, date: '2026-03-03', checkNumber: null, ...overrides,
  });
  const empty = () => ({ linkedLegs: new Set<string>(), linkedTransactionIds: new Set<string>(), rejectedPairs: new Set<string>() });

  it('links a unique exact-amount candidate on the mapped account', () => {
    const plan = planAutoLinks([leg()], [txn('t1')], empty());
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ transactionId: 't1', reasons: { daysApart: 1 } });
    expect(plan[0].confidence).toBeCloseTo(0.97);
  });

  it('requires the exact sign-aware amount and the same account', () => {
    expect(planAutoLinks([leg()], [txn('t1', { amountCents: 1500 })], empty())).toEqual([]);
    expect(planAutoLinks([leg()], [txn('t1', { amountCents: -1501 })], empty())).toEqual([]);
    expect(planAutoLinks([leg()], [txn('t1', { accountId: 'other' })], empty())).toEqual([]);
  });

  it('uses ±4 days normally and lets checks clear up to 10 days late', () => {
    expect(linkWindow('check')).toEqual({ before: 4, after: 10 });
    expect(planAutoLinks([leg()], [txn('t1', { date: '2026-03-07' })], empty())).toHaveLength(0);
    expect(planAutoLinks([leg()], [txn('t1', { date: '2026-02-26' })], empty())).toHaveLength(1);
    expect(planAutoLinks([leg({ paymentMethod: 'check' })], [txn('t1', { date: '2026-03-12' })], empty())).toHaveLength(1);
    expect(planAutoLinks([leg({ paymentMethod: 'check' })], [txn('t1', { date: '2026-03-13' })], empty())).toHaveLength(0);
    expect(planAutoLinks([leg({ paymentMethod: 'check' })], [txn('t1', { date: '2026-02-25' })], empty())).toHaveLength(0);
  });

  it('does not auto-link when more than one candidate fits', () => {
    expect(planAutoLinks([leg()], [txn('t1'), txn('t2', { date: '2026-03-04' })], empty())).toEqual([]);
  });

  it('lets a matching check number break the tie', () => {
    const plan = planAutoLinks(
      [leg({ paymentMethod: 'check', docNumber: '1051' })],
      [txn('t1', { date: '2026-03-05' }), txn('t2', { date: '2026-03-08', checkNumber: '001051' })],
      empty(),
    );
    expect(plan).toEqual([expect.objectContaining({ transactionId: 't2', confidence: 0.99, reasons: expect.objectContaining({ checkNumber: true }) })]);
  });

  it('drops both legs when two QBO transactions claim the same Ledger transaction', () => {
    const plan = planAutoLinks([leg(), leg({ qboTransactionId: 'q2', txnDate: '2026-03-04' })], [txn('t1')], empty());
    expect(plan).toEqual([]);
  });

  it('skips linked legs, taken Ledger transactions and rejected pairs', () => {
    const state = empty();
    state.linkedTransactionIds.add('t1');
    expect(planAutoLinks([leg()], [txn('t1')], state)).toEqual([]);
    const rejected = empty();
    rejected.rejectedPairs.add('q1|main|t1');
    expect(planAutoLinks([leg()], [txn('t1')], rejected)).toEqual([]);
    const linked = empty();
    linked.linkedLegs.add('q1|main');
    expect(planAutoLinks([leg()], [txn('t1')], linked)).toEqual([]);
  });

  it('flags auto links whose QBO side changed', () => {
    const l = { leg: 'main' as const, accountQboId: '35', amountCents: -1500 };
    expect(autoLinkIsStale(l, false, 'acct', { accountId: 'acct', amountCents: -1500 })).toBe(false);
    expect(autoLinkIsStale(l, true, 'acct', { accountId: 'acct', amountCents: -1500 })).toBe(true);
    expect(autoLinkIsStale({ ...l, amountCents: -1600 }, false, 'acct', { accountId: 'acct', amountCents: -1500 })).toBe(true);
    expect(autoLinkIsStale(l, false, null, { accountId: 'acct', amountCents: -1500 })).toBe(true);
  });
});

describe('contractors', () => {
  it('classifies 1099 vendors and contract-labor accounts', () => {
    expect(isContractLaborAccount({ name: 'Contract Labor' })).toBe(true);
    expect(isContractLaborAccount({ name: 'Freelance Writers' })).toBe(true);
    expect(isContractLaborAccount({ name: '1099 Payments' })).toBe(true);
    expect(isContractLaborAccount({ name: 'Outside Help', mappedCategoryName: 'Contract Labor' })).toBe(true);
    expect(isContractLaborAccount({ name: 'Meals' })).toBe(false);
    expect(classifyContractor({ vendor1099: true, paidFromContractLaborAccount: false })).toEqual(['vendor_1099']);
    expect(classifyContractor({ vendor1099: false, paidFromContractLaborAccount: false })).toEqual([]);
  });

  it('uses $600 through 2025 and $2,000 from 2026', () => {
    expect(necThreshold(2025)).toEqual({ cents: 60_000, exact: true });
    expect(necThreshold(2026)).toEqual({ cents: 200_000, exact: true });
    expect(necThreshold(2027)).toEqual({ cents: 200_000, exact: false });
    expect(necThreshold(2020).cents).toBe(60_000);
  });

  const pay = (overrides: Partial<ContractorPaymentInput>): ContractorPaymentInput => ({
    qboTransactionId: 'x', entityType: 'Purchase', vendorQboId: 'v1', txnDate: '2026-03-02', amountCents: 100_000,
    method: 'check', memo: null, docNumber: null, linkedTransactionId: null, ledgerReceiptStatus: null, qboAttachmentCount: 0, ...overrides,
  });

  it('totals period / YTD, excludes card payments from the reportable total, and flags the threshold', () => {
    const rows = buildContractorReport({
      vendors: [
        { qboId: 'v1', displayName: 'Jane', vendor1099: true, hasTaxId: true },
        { qboId: 'v2', displayName: 'Card Guy', vendor1099: true, hasTaxId: false },
        { qboId: 'v3', displayName: 'Google', vendor1099: false, hasTaxId: false },
        { qboId: 'v4', displayName: 'Priya', vendor1099: false, hasTaxId: false },
      ],
      payments: [
        pay({ txnDate: '2026-03-02', amountCents: 150_000, method: 'check', ledgerReceiptStatus: 'matched' }),
        pay({ txnDate: '2026-06-15', amountCents: 90_000, method: 'cash_ach', qboAttachmentCount: 1 }),
        pay({ txnDate: '2025-11-05', amountCents: 40_000 }),
        pay({ vendorQboId: 'v2', amountCents: 300_000, method: 'credit_card' }),
        pay({ vendorQboId: 'v3', amountCents: 5_000 }),
        pay({ vendorQboId: 'v4', amountCents: 120_000, method: 'cash_ach' }),
      ],
      contractLaborVendorIds: new Set(['v4']),
      from: '2026-06-01',
      to: '2026-09-27',
    });
    expect(rows.map((r) => r.name)).toEqual(['Jane', 'Card Guy', 'Priya']);
    const jane = rows.find((r) => r.name === 'Jane')!;
    expect(jane).toMatchObject({ periodPaidCents: 90_000, periodPaymentCount: 1, ytdPaidCents: 240_000, ytdReportableCents: 240_000, lastPaidDate: '2026-06-15', taxIdOnFile: true });
    expect(jane.threshold).toMatchObject({ year: 2026, cents: 200_000, meetsThreshold: true });
    expect(jane.payments[0].receiptStatus).toBe('attached_in_quickbooks');
    const card = rows.find((r) => r.name === 'Card Guy')!;
    expect(card.ytdReportableCents).toBe(0);
    expect(card.threshold.meetsThreshold).toBe(false);
    expect(rows.find((r) => r.name === 'Priya')!.reasons).toEqual(['contract_labor_account']);
  });

  it('applies the 2025 $600 threshold for a 2025 period', () => {
    const [row] = buildContractorReport({
      vendors: [{ qboId: 'v1', displayName: 'Jane', vendor1099: true, hasTaxId: false }],
      payments: [pay({ txnDate: '2025-11-05', amountCents: 70_000 })],
      contractLaborVendorIds: new Set(),
      from: '2025-01-01',
      to: '2025-12-31',
    });
    expect(row.threshold).toMatchObject({ year: 2025, cents: 60_000, meetsThreshold: true });
  });
});

describe('attachment import dedupe', () => {
  it('imports each attachable once and reuses identical bytes already in Ledger', () => {
    expect(decideAttachmentImport({ alreadyImportedReceiptId: 'r1', contentType: 'application/pdf', existingReceiptWithSameSha: null, businessId: 'b' }))
      .toEqual({ action: 'skip', reason: 'already_imported' });
    expect(decideAttachmentImport({ alreadyImportedReceiptId: null, contentType: 'application/vnd.ms-excel', existingReceiptWithSameSha: null, businessId: 'b' }))
      .toEqual({ action: 'skip', reason: 'unsupported_type' });
    expect(decideAttachmentImport({ alreadyImportedReceiptId: null, contentType: 'image/png', existingReceiptWithSameSha: { id: 'r9', businessId: 'b' }, businessId: 'b' }))
      .toEqual({ action: 'reuse', receiptId: 'r9' });
    expect(decideAttachmentImport({ alreadyImportedReceiptId: null, contentType: 'image/png', existingReceiptWithSameSha: { id: 'r9', businessId: 'other' }, businessId: 'b' }))
      .toEqual({ action: 'import' });
    expect(decideAttachmentImport({ alreadyImportedReceiptId: null, contentType: 'application/pdf', existingReceiptWithSameSha: null, businessId: 'b' }))
      .toEqual({ action: 'import' });
  });
});

describe('mappings and category signal', () => {
  it('suggests Ledger accounts by last-4 and compatible kind', () => {
    const ledger = [
      { id: 'a1', name: 'Checking', mask: '6789', kind: 'checking', businessId: 'b' },
      { id: 'a2', name: 'Card', mask: '6789', kind: 'credit', businessId: 'b' },
      { id: 'a3', name: 'Amex', mask: '1005', kind: 'credit', businessId: 'b' },
    ];
    expect(suggestLedgerAccounts({ name: 'Chase', accountType: 'Bank', acctNumLast4: '6789' }, ledger).map((a) => a.id)).toEqual(['a1']);
    expect(suggestLedgerAccounts({ name: 'Amex', accountType: 'Credit Card', acctNumLast4: '1005' }, ledger).map((a) => a.id)).toEqual(['a3']);
    expect(suggestLedgerAccounts({ name: 'Meals', accountType: 'Expense', acctNumLast4: '6789' }, ledger)).toEqual([]);
  });

  it('scores QBO expense accounts against Ledger categories', () => {
    expect(scoreCategoryMatch({ name: 'Contract Labor', accountSubType: null }, 'Contract Labor')).toBe(1);
    expect(scoreCategoryMatch({ name: 'Freelance Writers', fullyQualifiedName: 'Contract Labor:Freelance Writers', accountSubType: null }, 'Contract Labor')).toBeCloseTo(0.9);
    expect(scoreCategoryMatch({ name: 'Online Ads', accountSubType: 'AdvertisingPromotional' }, 'Advertising & Marketing')).toBeGreaterThanOrEqual(0.75);
    expect(scoreCategoryMatch({ name: 'Meals', accountSubType: null }, 'Software')).toBe(0);
    const pick = suggestCategory({ name: 'Legal & Professional Fees', accountSubType: 'LegalProfessionalFees' }, [
      { id: 'c1', name: 'Legal & Professional' }, { id: 'c2', name: 'Office Expense' },
    ]);
    expect(pick?.categoryId).toBe('c1');
  });

  it('suggests the category carrying most of the amount, weighted by mapping strength', () => {
    const mappings = new Map<string, CategoryMappingLite>([
      ['60', { qboId: '60', name: 'Contract Labor', categoryId: 'cat-labor', method: 'manual', score: null }],
      ['64', { qboId: '64', name: 'Meals', categoryId: 'cat-meals', method: 'auto', score: 1 }],
    ]);
    const qbo = { id: 'q1', entityType: 'Purchase', vendorQboId: '56', payeeName: 'Jane' };
    const s = computeCategorySuggestion('t1', qbo, [
      { amountCents: 90_000, accountQboId: '60', accountName: 'Contract Labor', description: null },
      { amountCents: 10_000, accountQboId: '64', accountName: 'Meals', description: null },
    ], mappings);
    expect(s).toMatchObject({ transactionId: 't1', categoryId: 'cat-labor', source: 'quickbooks', evidence: { lineShare: 0.9, mappingMethod: 'manual', vendor: { qboId: '56' } } });
    expect(s!.confidence).toBeCloseTo(0.81);
    // Split evenly → no confident suggestion.
    expect(computeCategorySuggestion('t1', qbo, [
      { amountCents: 50_000, accountQboId: '60', accountName: null, description: null },
      { amountCents: 50_000, accountQboId: '64', accountName: null, description: null },
    ], mappings)).toBeNull();
    // Unmapped accounts → nothing.
    expect(computeCategorySuggestion('t1', qbo, [{ amountCents: 1, accountQboId: '99', accountName: null, description: null }], mappings)).toBeNull();
  });
});
