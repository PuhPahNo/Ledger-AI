import type {
  QboContractorsReport,
  QboMappings,
  QboMappingsUpdate,
  QboStatus,
  QboTransactionDetails,
  QboLeg,
} from '@/types/quickbooks';
import { http, useMockApi } from './client';

// QuickBooks Online (read-only) client. In mock mode every call resolves to the fixtures
// below so the phase-2 UI can be built without a backend. Add `?mockQbo=unconfigured` (server
// has no QuickBooks credentials) or `?mockQbo=none` (configured, nothing connected) to the URL
// to demo those states.

type MockQboScenario = 'connected' | 'unconfigured' | 'none';

function mockScenario(): MockQboScenario {
  if (typeof window === 'undefined') return 'connected';
  const value = new URLSearchParams(window.location.search).get('mockQbo');
  return value === 'unconfigured' || value === 'none' ? value : 'connected';
}

let mockStatus: QboStatus | null = null;
let mockMappings: QboMappings | null = null;

/** Mutable copy of the fixture so Disconnect / Sync behave in mock mode. */
function mockQboStatus(): QboStatus {
  const scenario = mockScenario();
  if (scenario !== 'connected') {
    return {
      configured: scenario !== 'unconfigured',
      environment: scenario === 'unconfigured' ? null : 'sandbox',
      businesses: MOCK_QBO_STATUS.businesses.map((business) => ({ ...business, connection: null })),
    };
  }
  mockStatus ??= structuredClone(MOCK_QBO_STATUS);
  return mockStatus;
}

function mockHasConnections(): boolean {
  return mockQboStatus().businesses.some((business) => business.connection);
}

/** GET /api/quickbooks/status — `configured: false` means show "QuickBooks not configured". */
export function getQuickbooksStatus(): Promise<QboStatus> {
  if (useMockApi) return Promise.resolve(structuredClone(mockQboStatus()));
  return http<QboStatus>('/quickbooks/status');
}

/** POST /api/quickbooks/connect — returns the Intuit consent URL; navigate the window to it. */
export function startQuickbooksConnect(businessId: string): Promise<{ url: string }> {
  if (useMockApi) return Promise.reject(new Error('Connecting QuickBooks requires the real backend'));
  return http<{ url: string }>('/quickbooks/connect', { method: 'POST', body: JSON.stringify({ businessId }) });
}

/** POST /api/quickbooks/:connectionId/sync — `full` re-pulls 24 months instead of changes only. */
export function syncQuickbooks(connectionId: string, full = false): Promise<{ queued: boolean; jobId?: string; alreadyQueued?: boolean }> {
  if (useMockApi) {
    const connection = mockQboStatus().businesses.find((business) => business.connection?.id === connectionId)?.connection;
    if (connection) connection.lastSyncAt = new Date().toISOString();
    return Promise.resolve({ queued: true, jobId: 'mock-qbo-sync' });
  }
  return http(`/quickbooks/${connectionId}/sync`, { method: 'POST', body: JSON.stringify({ full }) });
}

/** DELETE /api/quickbooks/:connectionId — revokes the token; synced history is kept. */
export function disconnectQuickbooks(connectionId: string): Promise<void> {
  if (useMockApi) {
    const business = mockQboStatus().businesses.find((row) => row.connection?.id === connectionId);
    if (business) business.connection = null;
    return Promise.resolve();
  }
  return http<void>(`/quickbooks/${connectionId}`, { method: 'DELETE' });
}

/** GET /api/quickbooks/:connectionId/mappings */
export function getQuickbooksMappings(connectionId: string): Promise<QboMappings> {
  if (useMockApi) {
    mockMappings ??= structuredClone(MOCK_QBO_MAPPINGS);
    return Promise.resolve({ ...structuredClone(mockMappings), connectionId });
  }
  return http<QboMappings>(`/quickbooks/${connectionId}/mappings`);
}

/** PUT /api/quickbooks/:connectionId/mappings — manual choices (null = explicitly unmapped). */
export function updateQuickbooksMappings(
  connectionId: string,
  update: QboMappingsUpdate,
): Promise<{ bankAccounts: number; expenseAccounts: number; relinkQueued: boolean; mappings: QboMappings }> {
  if (useMockApi) {
    mockMappings ??= structuredClone(MOCK_QBO_MAPPINGS);
    const mappings = mockMappings;
    for (const change of update.bankAccounts ?? []) {
      const row = mappings.bankAccounts.find((b) => b.qboAccount.id === change.qboAccountId);
      if (row) Object.assign(row, { ledgerAccountId: change.ledgerAccountId, method: 'manual' });
    }
    for (const change of update.expenseAccounts ?? []) {
      const row = mappings.expenseAccounts.find((e) => e.qboAccount.id === change.qboAccountId);
      if (row) {
        Object.assign(row, {
          categoryId: change.categoryId,
          categoryName: mappings.categories.find((c) => c.id === change.categoryId)?.name ?? null,
          method: 'manual',
        });
      }
    }
    return Promise.resolve({
      bankAccounts: update.bankAccounts?.length ?? 0,
      expenseAccounts: update.expenseAccounts?.length ?? 0,
      relinkQueued: true,
      mappings: { ...structuredClone(mappings), connectionId },
    });
  }
  return http(`/quickbooks/${connectionId}/mappings`, { method: 'PUT', body: JSON.stringify(update) });
}

/** GET /api/quickbooks/contractors?biz&from&to (defaults: year-to-date). */
export function getQuickbooksContractors(params: { biz?: string | 'all'; from?: string; to?: string } = {}): Promise<QboContractorsReport> {
  if (useMockApi) {
    const connected = new Set(mockQboStatus().businesses
      .filter((business) => business.connection && (!params.biz || params.biz === 'all' || business.businessKey === params.biz))
      .map((business) => business.businessId));
    const report = structuredClone(MOCK_QBO_CONTRACTORS);
    report.companies = report.companies.filter((company) => connected.has(company.businessId));
    return Promise.resolve(report);
  }
  const query = new URLSearchParams();
  if (params.biz && params.biz !== 'all') query.set('biz', params.biz);
  if (params.from) query.set('from', params.from);
  if (params.to) query.set('to', params.to);
  return http<QboContractorsReport>(`/quickbooks/contractors?${query.toString()}`);
}

/** GET /api/transactions/:id/quickbooks — QBO payee, accounts, memo, attachments for the drawer. */
export function getTransactionQuickbooks(transactionId: string): Promise<QboTransactionDetails> {
  if (useMockApi) {
    if (!mockHasConnections()) return Promise.resolve({ transactionId, links: [], categorySuggestion: null, candidates: [] });
    return Promise.resolve({ ...structuredClone(MOCK_QBO_TRANSACTION_DETAILS), transactionId });
  }
  return http<QboTransactionDetails>(`/transactions/${transactionId}/quickbooks`);
}

/** POST /api/quickbooks/links — manual link (replaces any existing link on either side). */
export function linkQuickbooksTransaction(input: { transactionId: string; qboTransactionId: string; leg?: QboLeg }): Promise<QboTransactionDetails> {
  if (useMockApi) return Promise.resolve({ ...structuredClone(MOCK_QBO_TRANSACTION_DETAILS), transactionId: input.transactionId });
  return http<QboTransactionDetails>('/quickbooks/links', { method: 'POST', body: JSON.stringify(input) });
}

/** DELETE /api/quickbooks/links/:linkId — unlink; auto-linking won't re-create it. */
export function unlinkQuickbooksTransaction(linkId: string): Promise<QboTransactionDetails> {
  if (useMockApi) {
    return Promise.resolve({
      ...structuredClone(MOCK_QBO_TRANSACTION_DETAILS),
      links: [],
      categorySuggestion: null,
      candidates: [structuredClone(MOCK_QBO_TRANSACTION_DETAILS.links[0].qboTransaction)],
    });
  }
  return http<QboTransactionDetails>(`/quickbooks/links/${linkId}`, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------------------------
// Mock fixtures (same company as server/scripts/qbo-mock-server.ts)
// ---------------------------------------------------------------------------------------------

export const MOCK_QBO_STATUS: QboStatus = {
  configured: true,
  environment: 'sandbox',
  businesses: [
    {
      businessId: 'biz-draft-sharks',
      businessKey: 'draft-sharks',
      businessName: 'Draft Sharks',
      connection: {
        id: 'qbo-conn-ds',
        status: 'live',
        companyName: 'Draft Sharks LLC',
        realmId: '9341453050711111',
        environment: 'sandbox',
        lastSyncAt: '2026-09-27T09:02:00.000Z',
        lastFullSyncAt: '2026-09-20T09:00:00.000Z',
        lastSyncError: null,
        historyStartDate: '2024-09-01',
        syncing: false,
        counts: { accounts: 12, vendors: 7, transactions: 16, linked: 11, attachments: 5, unmappedBankAccounts: 1 },
      },
    },
    {
      businessId: 'biz-pointsnav',
      businessKey: 'pointsnav',
      businessName: 'PointsNav',
      connection: {
        id: 'qbo-conn-pn',
        status: 'reauth',
        companyName: 'PointsNav Inc.',
        realmId: '9341453050722222',
        environment: 'sandbox',
        lastSyncAt: '2026-08-02T09:00:00.000Z',
        lastFullSyncAt: '2026-07-01T09:00:00.000Z',
        lastSyncError: 'QuickBooks authorization expired or was revoked. Reconnect QuickBooks.',
        historyStartDate: '2024-07-01',
        syncing: false,
        counts: { accounts: 30, vendors: 41, transactions: 612, linked: 540, attachments: 88, unmappedBankAccounts: 0 },
      },
    },
    { businessId: 'biz-womens-net', businessKey: 'womens-net', businessName: 'Womens Net', connection: null },
  ],
};

const account = (id: string, qboId: string, name: string, accountType: string, acctNumLast4: string | null = null, accountSubType: string | null = null) => ({
  id, qboId, name, fullyQualifiedName: name, accountType, accountSubType, acctNumLast4, active: true,
});

export const MOCK_QBO_MAPPINGS: QboMappings = {
  connectionId: 'qbo-conn-ds',
  businessId: 'biz-draft-sharks',
  bankAccounts: [
    { qboAccount: account('qa-35', '35', 'Chase Business Checking', 'Bank', '6789', 'Checking'), ledgerAccountId: 'acct-chase', method: 'auto', suggestions: [{ ledgerAccountId: 'acct-chase', name: 'Chase Checking', mask: '6789', reason: 'last4' }] },
    { qboAccount: account('qa-41', '41', 'Amex Business Platinum', 'Credit Card', '1005', 'CreditCard'), ledgerAccountId: 'acct-amex', method: 'auto', suggestions: [{ ledgerAccountId: 'acct-amex', name: 'Amex Platinum', mask: '1005', reason: 'last4' }] },
    { qboAccount: account('qa-36', '36', 'Chase Savings 4321', 'Bank', '4321', 'Savings'), ledgerAccountId: null, method: null, suggestions: [] },
  ],
  expenseAccounts: [
    { qboAccount: account('qa-60', '60', 'Contract Labor', 'Expense'), categoryId: 'cat-contract', categoryName: 'Contract Labor', method: 'auto', score: 1, suggestion: { categoryId: 'cat-contract', name: 'Contract Labor', score: 1 }, contractLabor: true },
    { qboAccount: { ...account('qa-61', '61', 'Freelance Writers', 'Expense'), fullyQualifiedName: 'Contract Labor:Freelance Writers' }, categoryId: 'cat-contract', categoryName: 'Contract Labor', method: 'auto', score: 0.9, suggestion: { categoryId: 'cat-contract', name: 'Contract Labor', score: 0.9 }, contractLabor: true },
    { qboAccount: account('qa-62', '62', 'Advertising & Marketing', 'Expense', null, 'AdvertisingPromotional'), categoryId: 'cat-ads', categoryName: 'Advertising & Marketing', method: 'auto', score: 1, suggestion: { categoryId: 'cat-ads', name: 'Advertising & Marketing', score: 1 }, contractLabor: false },
    { qboAccount: account('qa-63', '63', 'Software & Subscriptions', 'Expense', null, 'DuesSubscriptions'), categoryId: 'cat-software', categoryName: 'Software', method: 'manual', score: null, suggestion: { categoryId: 'cat-software', name: 'Software', score: 1 }, contractLabor: false },
    { qboAccount: account('qa-64', '64', 'Meals', 'Expense', null, 'EntertainmentMeals'), categoryId: null, categoryName: null, method: null, score: null, suggestion: { categoryId: 'cat-meals', name: 'Meals', score: 1 }, contractLabor: false },
  ],
  ledgerAccounts: [
    { id: 'acct-chase', name: 'Chase Checking', mask: '6789', kind: 'checking' },
    { id: 'acct-amex', name: 'Amex Platinum', mask: '1005', kind: 'credit' },
  ],
  categories: [
    { id: 'cat-contract', name: 'Contract Labor' },
    { id: 'cat-ads', name: 'Advertising & Marketing' },
    { id: 'cat-software', name: 'Software' },
    { id: 'cat-meals', name: 'Meals' },
  ],
};

const payment = (p: Partial<QboContractorsReport['companies'][number]['contractors'][number]['payments'][number]>) => ({
  qboTransactionId: 'qt',
  entityType: 'Purchase' as const,
  vendorQboId: '56',
  txnDate: '2026-03-02',
  amountCents: 0,
  method: 'check' as const,
  memo: null,
  docNumber: null,
  linkedTransactionId: null,
  ledgerReceiptStatus: null,
  qboAttachmentCount: 0,
  receiptStatus: 'none',
  ...p,
});

export const MOCK_QBO_CONTRACTORS: QboContractorsReport = {
  from: '2026-01-01',
  to: '2026-09-27',
  threshold: {
    year: 2026,
    cents: 200_000,
    exact: true,
    guidance: 'Guidance only, not tax advice. 1099-NEC threshold: $600 for payments through 2025, $2,000 for payments in 2026 (indexed for inflation after 2026). Card/third-party-network payments are generally reported on 1099-K by the processor, so they are excluded from the reportable total. Confirm with your accountant.',
  },
  companies: [{
    connectionId: 'qbo-conn-ds',
    businessId: 'biz-draft-sharks',
    companyName: 'Draft Sharks LLC',
    contractors: [
      {
        vendorQboId: '56', name: 'Jane Doe Design', reasons: ['vendor_1099', 'contract_labor_account'], vendor1099: true, taxIdOnFile: true,
        periodPaidCents: 240_000, periodPaymentCount: 2, ytdPaidCents: 240_000, ytdReportableCents: 240_000, lastPaidDate: '2026-06-15',
        paymentMethods: ['cash_ach', 'check'], threshold: { year: 2026, cents: 200_000, exact: true, meetsThreshold: true },
        payments: [
          payment({ qboTransactionId: 'qt-1002', txnDate: '2026-06-15', amountCents: 90_000, method: 'cash_ach', memo: 'ACH — landing page mockups', linkedTransactionId: 'txn-ach-jane', ledgerReceiptStatus: 'missing', receiptStatus: 'missing' }),
          payment({ qboTransactionId: 'qt-1001', txnDate: '2026-03-02', amountCents: 150_000, docNumber: '1042', memo: 'Logo refresh — March', linkedTransactionId: 'txn-check-1042', ledgerReceiptStatus: 'missing', receiptStatus: 'missing' }),
        ],
      },
      {
        vendorQboId: '62', name: 'Alex Kim (Upwork)', reasons: ['vendor_1099', 'contract_labor_account'], vendor1099: true, taxIdOnFile: false,
        periodPaidCents: 240_000, periodPaymentCount: 1, ytdPaidCents: 240_000, ytdReportableCents: 0, lastPaidDate: '2026-08-12',
        paymentMethods: ['credit_card'], threshold: { year: 2026, cents: 200_000, exact: true, meetsThreshold: false },
        payments: [payment({ qboTransactionId: 'qt-1006', vendorQboId: '62', txnDate: '2026-08-12', amountCents: 240_000, method: 'credit_card', linkedTransactionId: 'txn-upwork', ledgerReceiptStatus: 'missing', receiptStatus: 'missing' })],
      },
      {
        vendorQboId: '57', name: 'Mike Rivera (Writer)', reasons: ['vendor_1099', 'contract_labor_account'], vendor1099: true, taxIdOnFile: false,
        periodPaidCents: 205_000, periodPaymentCount: 2, ytdPaidCents: 205_000, ytdReportableCents: 205_000, lastPaidDate: '2026-08-20',
        paymentMethods: ['check'], threshold: { year: 2026, cents: 200_000, exact: true, meetsThreshold: true },
        payments: [
          payment({ qboTransactionId: 'qt-3001', entityType: 'BillPayment', vendorQboId: '57', txnDate: '2026-08-20', amountCents: 130_000, docNumber: '1051', linkedTransactionId: 'txn-check-1051', ledgerReceiptStatus: 'missing', receiptStatus: 'missing' }),
          payment({ qboTransactionId: 'qt-1005', vendorQboId: '57', txnDate: '2026-04-10', amountCents: 75_000, docNumber: '1043', memo: 'April articles', linkedTransactionId: 'txn-check-1043', ledgerReceiptStatus: 'matched', qboAttachmentCount: 1, receiptStatus: 'matched' }),
        ],
      },
      {
        vendorQboId: '58', name: 'Priya Patel Consulting', reasons: ['contract_labor_account'], vendor1099: false, taxIdOnFile: true,
        periodPaidCents: 120_000, periodPaymentCount: 1, ytdPaidCents: 120_000, ytdReportableCents: 120_000, lastPaidDate: '2026-02-20',
        paymentMethods: ['cash_ach'], threshold: { year: 2026, cents: 200_000, exact: true, meetsThreshold: false },
        payments: [payment({ qboTransactionId: 'qt-1007', vendorQboId: '58', txnDate: '2026-02-20', amountCents: 120_000, method: 'cash_ach', memo: 'Strategy retainer', linkedTransactionId: 'txn-ach-priya', ledgerReceiptStatus: 'missing', receiptStatus: 'missing' })],
      },
    ],
  }],
};

export const MOCK_QBO_TRANSACTION_DETAILS: QboTransactionDetails = {
  transactionId: 'txn-check-1043',
  links: [{
    linkId: 'link-1',
    leg: 'main',
    method: 'auto',
    confidence: 0.83,
    reasons: { exactAmount: true, daysApart: 8, sameAccount: true, candidateCount: 1 },
    qboTransaction: {
      id: 'qt-1005',
      connectionId: 'qbo-conn-ds',
      entityType: 'Purchase',
      qboId: '1005',
      txnDate: '2026-04-10',
      totalCents: 75_000,
      paymentMethod: 'check',
      docNumber: '1043',
      memo: 'April articles',
      payeeName: 'Mike Rivera (Writer)',
      vendorQboId: '57',
      bankAccountName: 'Chase Business Checking',
      legs: [{ leg: 'main', accountQboId: '35', amountCents: -75_000 }],
      deleted: false,
    },
    vendor: { qboId: '57', name: 'Mike Rivera (Writer)', vendor1099: true, taxIdOnFile: false },
    expenseAccounts: [{ qboAccountId: '61', name: 'Freelance Writers', amountCents: 75_000, description: null, categoryId: 'cat-contract', categoryName: 'Contract Labor' }],
    attachments: [{ id: 'qatt-7002', fileName: 'rivera-invoice-0410.png', contentType: 'image/png', importStatus: 'imported', receiptId: 'rcpt-rivera' }],
    isContractor: true,
  }],
  categorySuggestion: {
    transactionId: 'txn-check-1043',
    categoryId: 'cat-contract',
    source: 'quickbooks',
    confidence: 0.765,
    evidence: {
      qboAccount: { qboId: '61', name: 'Freelance Writers' },
      vendor: { qboId: '57', name: 'Mike Rivera (Writer)' },
      qboTransactionId: 'qt-1005',
      entityType: 'Purchase',
      mappingMethod: 'auto',
      lineShare: 1,
    },
  },
  candidates: [],
};
