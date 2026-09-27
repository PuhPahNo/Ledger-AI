/**
 * Local QuickBooks Online mock (OAuth + read-only Accounting API) for development and e2e tests.
 *
 *   npm run qbo:mock            # listens on http://localhost:8799
 *
 * Point the app at it (never in production):
 *   QUICKBOOKS_CLIENT_ID=mock-client QUICKBOOKS_CLIENT_SECRET=mock-secret
 *   QUICKBOOKS_REDIRECT_URI=http://localhost:8787/api/quickbooks/callback
 *   QUICKBOOKS_ENV=sandbox
 *   QUICKBOOKS_API_BASE=http://localhost:8799
 *   QUICKBOOKS_AUTH_BASE=http://localhost:8799
 *
 * The consent screen is skipped: /connect/oauth2 redirects straight back with a code and
 * realmId 9341453050711111. Refresh tokens ROTATE (like Intuit): each refresh invalidates the
 * previous one; unknown/old tokens get `invalid_grant`. Restarting the mock forgets tokens, so the
 * app will flag the connection for re-auth — set QBO_MOCK_LENIENT=true to accept any mock token.
 *
 * Env knobs: QBO_MOCK_PORT (8799), QBO_MOCK_ACCESS_TTL seconds (3600),
 * QBO_MOCK_RATE_LIMIT_EVERY=n (every nth API call returns 429 with Retry-After: 1).
 * POST /__mock/mutate edits a purchase and deletes another (exercises CDC + deletes).
 *
 * Fixture company "Draft Sharks LLC (Mock)" — 1099 contractors paid by check / ACH / card, bills
 * + bill payments, a deposit, a transfer, a vendor credit and attachments. Matching Ledger (Plaid)
 * transactions for a local test (accounts: checking mask 6789, credit card mask 1005):
 *   checking 2026-03-09  -1500.00  JANE DOE DESIGN CHECK 1042        (check P1001, cleared +7d)
 *   checking 2026-06-16   -900.00  ACH JANE DOE DESIGN               (P1002)
 *   credit   2026-05-04   -412.37  GOOGLE ADS                        (P1003, has attachment)
 *   credit   2026-07-01    -45.00  FIGMA                             (P1004 — ambiguous with ↓)
 *   credit   2026-07-03    -45.00  FIGMA                             (→ no auto link)
 *   checking 2026-04-18   -750.00  CHECK 1043                        (P1005, check +8d, attachment)
 *   credit   2026-08-13  -2400.00  UPWORK ALEX KIM                   (P1006, card → not 1099-NEC)
 *   checking 2026-02-23  -1200.00  ACH PRIYA PATEL                   (P1007, contract labor acct)
 *   credit   2026-05-20    +50.00  GOOGLE ADS REFUND                 (P1009 credit)
 *   checking 2026-08-27  -1300.00  CHECK 1051 (raw.check_number=1051) (bill payment BP3001)
 *   checking 2026-04-16  -2500.00  SMITH CO CPA                      (bill payment BP3002, attachment)
 *   checking 2026-07-01 +12000.00  DEPOSIT                           (D4001)
 *   checking 2026-07-15  -5000.00  TRANSFER TO SAVINGS               (T5001 'from' leg)
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const PORT = Number(process.env.QBO_MOCK_PORT ?? 8799);
const ACCESS_TTL = Number(process.env.QBO_MOCK_ACCESS_TTL ?? 3600);
const RATE_LIMIT_EVERY = Number(process.env.QBO_MOCK_RATE_LIMIT_EVERY ?? 0);
const LENIENT = process.env.QBO_MOCK_LENIENT === 'true';
export const MOCK_REALM_ID = '9341453050711111';
const BASE = `http://localhost:${PORT}`;

type Entity = Record<string, any>;

function meta(created: string, updated = created) {
  return { CreateTime: `${created}T09:00:00-07:00`, LastUpdatedTime: `${updated}T09:00:00-07:00` };
}

const ref = (value: string, name: string, type?: string) => ({ value, name, ...(type ? { type } : {}) });
const expenseLine = (amount: number, accountId: string, accountName: string, description?: string) => ({
  Amount: amount,
  DetailType: 'AccountBasedExpenseLineDetail',
  Description: description,
  AccountBasedExpenseLineDetail: { AccountRef: ref(accountId, accountName) },
});

const store: Record<string, Entity[]> = {
  Account: [
    { Id: '35', Name: 'Chase Business Checking', AccountType: 'Bank', AccountSubType: 'Checking', Classification: 'Asset', AcctNum: '000123456789', CurrentBalance: 48211.07 },
    { Id: '41', Name: 'Amex Business Platinum', AccountType: 'Credit Card', AccountSubType: 'CreditCard', Classification: 'Liability', AcctNum: '31005', CurrentBalance: 2811.4 },
    { Id: '36', Name: 'Chase Savings 4321', AccountType: 'Bank', AccountSubType: 'Savings', Classification: 'Asset', CurrentBalance: 25000 },
    { Id: '60', Name: 'Contract Labor', AccountType: 'Expense', AccountSubType: 'OtherMiscellaneousServiceCost', Classification: 'Expense' },
    { Id: '61', Name: 'Freelance Writers', FullyQualifiedName: 'Contract Labor:Freelance Writers', AccountType: 'Expense', AccountSubType: 'OtherMiscellaneousServiceCost', Classification: 'Expense' },
    { Id: '62', Name: 'Advertising & Marketing', AccountType: 'Expense', AccountSubType: 'AdvertisingPromotional', Classification: 'Expense' },
    { Id: '63', Name: 'Software & Subscriptions', AccountType: 'Expense', AccountSubType: 'DuesSubscriptions', Classification: 'Expense' },
    { Id: '64', Name: 'Meals', AccountType: 'Expense', AccountSubType: 'EntertainmentMeals', Classification: 'Expense' },
    { Id: '65', Name: 'Legal & Professional Fees', AccountType: 'Expense', AccountSubType: 'LegalProfessionalFees', Classification: 'Expense' },
    { Id: '33', Name: 'Accounts Payable (A/P)', AccountType: 'Accounts Payable', AccountSubType: 'AccountsPayable', Classification: 'Liability' },
    { Id: '79', Name: 'Sales', AccountType: 'Income', AccountSubType: 'SalesOfProductIncome', Classification: 'Revenue' },
    { Id: '90', Name: 'Old Petty Cash', AccountType: 'Bank', AccountSubType: 'CashOnHand', Classification: 'Asset', Active: false },
  ].map((a) => ({ Active: true, SyncToken: '0', FullyQualifiedName: a.Name, ...a, MetaData: meta('2024-01-02') })),
  Vendor: [
    { Id: '56', DisplayName: 'Jane Doe Design', Vendor1099: true, TaxIdentifier: 'XXX-XX-1234' },
    { Id: '57', DisplayName: 'Mike Rivera (Writer)', Vendor1099: true },
    { Id: '58', DisplayName: 'Priya Patel Consulting', CompanyName: 'Patel Consulting LLC', Vendor1099: false, TaxIdentifier: 'XX-XXX6789' },
    { Id: '59', DisplayName: 'Google Ads', Vendor1099: false },
    { Id: '60', DisplayName: 'Figma', Vendor1099: false },
    { Id: '61', DisplayName: 'Smith & Co CPA', Vendor1099: true, TaxIdentifier: 'XX-XXX1111' },
    { Id: '62', DisplayName: 'Alex Kim (Upwork)', Vendor1099: true },
  ].map((v) => ({ Active: true, SyncToken: '0', Balance: 0, ...v, MetaData: meta('2024-02-01') })),
  Purchase: [
    { Id: '1001', PaymentType: 'Check', DocNumber: '1042', TxnDate: '2026-03-02', TotalAmt: 1500, AccountRef: ref('35', 'Chase Business Checking'), EntityRef: ref('56', 'Jane Doe Design', 'Vendor'), PrivateNote: 'Logo refresh — March', Line: [expenseLine(1500, '60', 'Contract Labor', 'Brand design')] },
    { Id: '1002', PaymentType: 'Cash', TxnDate: '2026-06-15', TotalAmt: 900, AccountRef: ref('35', 'Chase Business Checking'), EntityRef: ref('56', 'Jane Doe Design', 'Vendor'), PrivateNote: 'ACH — landing page mockups', Line: [expenseLine(900, '60', 'Contract Labor')] },
    { Id: '1003', PaymentType: 'CreditCard', TxnDate: '2026-05-03', TotalAmt: 412.37, AccountRef: ref('41', 'Amex Business Platinum'), EntityRef: ref('59', 'Google Ads', 'Vendor'), Line: [expenseLine(412.37, '62', 'Advertising & Marketing')] },
    { Id: '1004', PaymentType: 'CreditCard', TxnDate: '2026-07-01', TotalAmt: 45, AccountRef: ref('41', 'Amex Business Platinum'), EntityRef: ref('60', 'Figma', 'Vendor'), Line: [expenseLine(45, '63', 'Software & Subscriptions')] },
    { Id: '1005', PaymentType: 'Check', DocNumber: '1043', TxnDate: '2026-04-10', TotalAmt: 750, AccountRef: ref('35', 'Chase Business Checking'), EntityRef: ref('57', 'Mike Rivera (Writer)', 'Vendor'), PrivateNote: 'April articles', Line: [expenseLine(750, '61', 'Contract Labor:Freelance Writers')] },
    { Id: '1006', PaymentType: 'CreditCard', TxnDate: '2026-08-12', TotalAmt: 2400, AccountRef: ref('41', 'Amex Business Platinum'), EntityRef: ref('62', 'Alex Kim (Upwork)', 'Vendor'), Line: [expenseLine(2400, '60', 'Contract Labor')] },
    { Id: '1007', PaymentType: 'Cash', TxnDate: '2026-02-20', TotalAmt: 1200, AccountRef: ref('35', 'Chase Business Checking'), EntityRef: ref('58', 'Priya Patel Consulting', 'Vendor'), Line: [expenseLine(1200, '60', 'Contract Labor', 'Strategy retainer')] },
    { Id: '1008', PaymentType: 'Cash', TxnDate: '2025-11-05', TotalAmt: 400, AccountRef: ref('35', 'Chase Business Checking'), EntityRef: ref('56', 'Jane Doe Design', 'Vendor'), Line: [expenseLine(400, '60', 'Contract Labor')] },
    { Id: '1009', PaymentType: 'CreditCard', Credit: true, TxnDate: '2026-05-20', TotalAmt: 50, AccountRef: ref('41', 'Amex Business Platinum'), EntityRef: ref('59', 'Google Ads', 'Vendor'), PrivateNote: 'Invalid click credit', Line: [expenseLine(50, '62', 'Advertising & Marketing')] },
    { Id: '1010', PaymentType: 'CreditCard', TxnDate: '2026-06-02', TotalAmt: 86.2, AccountRef: ref('41', 'Amex Business Platinum'), EntityRef: ref('59', 'Google Ads', 'Vendor'), Line: [expenseLine(60, '64', 'Meals'), expenseLine(26.2, '62', 'Advertising & Marketing')] },
    { Id: '999', PaymentType: 'Cash', TxnDate: '2024-01-15', TotalAmt: 99, AccountRef: ref('35', 'Chase Business Checking'), EntityRef: ref('59', 'Google Ads', 'Vendor'), Line: [expenseLine(99, '62', 'Advertising & Marketing')] },
  ],
  Bill: [
    { Id: '2001', TxnDate: '2026-08-01', DueDate: '2026-08-31', TotalAmt: 1300, VendorRef: ref('57', 'Mike Rivera (Writer)'), APAccountRef: ref('33', 'Accounts Payable (A/P)'), DocNumber: 'MR-0801', Line: [expenseLine(1300, '61', 'Contract Labor:Freelance Writers', 'July articles')] },
    { Id: '2002', TxnDate: '2026-03-31', DueDate: '2026-04-15', TotalAmt: 2500, VendorRef: ref('61', 'Smith & Co CPA'), APAccountRef: ref('33', 'Accounts Payable (A/P)'), DocNumber: 'INV-4471', Line: [expenseLine(2500, '65', 'Legal & Professional Fees', '2025 tax return')] },
  ],
  BillPayment: [
    { Id: '3001', PayType: 'Check', DocNumber: '1051', TxnDate: '2026-08-20', TotalAmt: 1300, VendorRef: ref('57', 'Mike Rivera (Writer)'), CheckPayment: { BankAccountRef: ref('35', 'Chase Business Checking') }, Line: [{ Amount: 1300, LinkedTxn: [{ TxnId: '2001', TxnType: 'Bill' }] }] },
    { Id: '3002', PayType: 'Check', TxnDate: '2026-04-15', TotalAmt: 2500, VendorRef: ref('61', 'Smith & Co CPA'), CheckPayment: { BankAccountRef: ref('35', 'Chase Business Checking') }, PrivateNote: 'Paid via bill pay (ACH)', Line: [{ Amount: 2500, LinkedTxn: [{ TxnId: '2002', TxnType: 'Bill' }] }] },
  ],
  Deposit: [
    { Id: '4001', TxnDate: '2026-06-30', TotalAmt: 12000, DepositToAccountRef: ref('35', 'Chase Business Checking'), PrivateNote: 'June subscriptions payout', Line: [{ Amount: 12000, DetailType: 'DepositLineDetail', DepositLineDetail: { AccountRef: ref('79', 'Sales') } }] },
  ],
  Transfer: [
    { Id: '5001', TxnDate: '2026-07-15', Amount: 5000, FromAccountRef: ref('35', 'Chase Business Checking'), ToAccountRef: ref('36', 'Chase Savings 4321'), PrivateNote: 'Tax reserve' },
  ],
  VendorCredit: [
    { Id: '6001', TxnDate: '2026-07-10', TotalAmt: 10, VendorRef: ref('60', 'Figma'), APAccountRef: ref('33', 'Accounts Payable (A/P)'), Line: [expenseLine(10, '63', 'Software & Subscriptions')] },
  ],
  Attachable: [
    { Id: '7001', FileName: 'google-ads-may.pdf', ContentType: 'application/pdf', Size: 1200, AttachableRef: [{ EntityRef: { type: 'Purchase', value: '1003' } }] },
    { Id: '7002', FileName: 'rivera-invoice-0410.png', ContentType: 'image/png', Size: 900, AttachableRef: [{ EntityRef: { type: 'Purchase', value: '1005' } }] },
    { Id: '7003', FileName: 'smith-cpa-invoice-4471.pdf', ContentType: 'application/pdf', Size: 1300, AttachableRef: [{ EntityRef: { type: 'BillPayment', value: '3002' } }] },
    { Id: '7004', FileName: 'jane-doe-w9.pdf', ContentType: 'application/pdf', Size: 1500, Note: 'W-9', AttachableRef: [{ EntityRef: { type: 'Vendor', value: '56' } }] },
    { Id: '7005', FileName: 'figma-july.pdf', ContentType: 'application/pdf', Size: 1100, AttachableRef: [{ EntityRef: { type: 'Purchase', value: '1004' } }] },
  ],
};
for (const entity of ['Purchase', 'Bill', 'BillPayment', 'Deposit', 'Transfer', 'VendorCredit', 'Attachable']) {
  for (const item of store[entity]) {
    item.SyncToken ??= '0';
    item.MetaData ??= meta(item.TxnDate ?? '2026-05-05');
  }
}
const deleted: Record<string, Array<{ Id: string; at: string }>> = {};

// --- tiny file generators (valid PDF / PNG, no deps) --------------------------------------------

function pdf(text: string): Buffer {
  const content = `BT /F1 14 Tf 40 780 Td (${text.replace(/[()\\]/g, '')}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function png(seed: number): Buffer {
  const width = 8;
  const height = 8;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width * 3; x += 1) raw[y * (width * 3 + 1) + 1 + x] = (seed * 37 + x * 11 + y * 23) & 0xff;
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function fileFor(attachable: Entity): { body: Buffer; type: string } {
  if (String(attachable.ContentType).startsWith('image/png')) return { body: png(Number(attachable.Id)), type: 'image/png' };
  return { body: pdf(`Mock QuickBooks attachment ${attachable.FileName}`), type: 'application/pdf' };
}

// --- OAuth state -------------------------------------------------------------------------------

const accessTokens = new Map<string, number>(); // token -> expiry epoch ms
const refreshTokens = new Set<string>();
let requestCounter = 0;

function issueTokens() {
  const access = `mock-access-${randomBytes(9).toString('base64url')}`;
  const refresh = `mock-refresh-${randomBytes(9).toString('base64url')}`;
  accessTokens.set(access, Date.now() + ACCESS_TTL * 1000);
  refreshTokens.add(refresh);
  return {
    token_type: 'bearer',
    access_token: access,
    refresh_token: refresh,
    expires_in: ACCESS_TTL,
    x_refresh_token_expires_in: 8_726_400,
  };
}

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function fault(res: http.ServerResponse, status: number, message: string) {
  json(res, status, { Fault: { Error: [{ Message: message, Detail: message, code: String(status) }], type: status === 401 ? 'AUTHENTICATION' : 'ValidationFault' }, time: new Date().toISOString() });
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

// --- Query engine (the subset Ledger uses) -------------------------------------------------------

function applyWhere(items: Entity[], where: string): Entity[] {
  let out = items;
  const txnDate = where.match(/TxnDate\s*>=\s*'([^']+)'/i);
  if (txnDate) out = out.filter((i) => String(i.TxnDate ?? '') >= txnDate[1]);
  const updated = where.match(/MetaData\.LastUpdatedTime\s*>=\s*'([^']+)'/i);
  if (updated) out = out.filter((i) => new Date(i.MetaData.LastUpdatedTime) >= new Date(updated[1]));
  // Real QBO hides inactive Accounts/Vendors unless "Active IN (true, false)" is given.
  if ((out[0]?.Active !== undefined) && !/Active\s+IN/i.test(where)) out = out.filter((i) => i.Active !== false);
  return out;
}

function runQuery(statement: string): { entity: string; items: Entity[]; start: number; max: number } | null {
  const m = statement.match(/^\s*select\s+\*\s+from\s+(\w+)(?:\s+where\s+(.+?))?(?:\s+startposition\s+(\d+))?(?:\s+maxresults\s+(\d+))?\s*$/i);
  if (!m) return null;
  const entity = Object.keys(store).find((k) => k.toLowerCase() === m[1].toLowerCase());
  if (!entity) return null;
  const start = Number(m[3] ?? 1);
  const max = Math.min(1000, Number(m[4] ?? 100));
  const filtered = applyWhere(store[entity], m[2] ?? '');
  return { entity, items: filtered.slice(start - 1, start - 1 + max), start, max };
}

function withTempUri(entity: string, item: Entity): Entity {
  if (entity !== 'Attachable') return item;
  return { ...item, TempDownloadUri: `${BASE}/files/${item.Id}?sig=${randomBytes(6).toString('hex')}` };
}

// --- Server ------------------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', BASE);
    const p = url.pathname;

    if (req.method === 'GET' && p === '/connect/oauth2') {
      const redirect = url.searchParams.get('redirect_uri');
      const state = url.searchParams.get('state') ?? '';
      if (!redirect) return fault(res, 400, 'redirect_uri required');
      const target = new URL(redirect);
      target.searchParams.set('code', `mock-code-${randomBytes(6).toString('hex')}`);
      target.searchParams.set('state', state);
      target.searchParams.set('realmId', MOCK_REALM_ID);
      res.writeHead(302, { Location: target.toString() });
      return res.end();
    }

    if (req.method === 'POST' && p === '/oauth2/v1/tokens/bearer') {
      if (!String(req.headers.authorization ?? '').startsWith('Basic ')) return json(res, 401, { error: 'invalid_client' });
      const form = new URLSearchParams(await readBody(req));
      if (form.get('grant_type') === 'authorization_code') {
        if (!form.get('code')) return json(res, 400, { error: 'invalid_grant' });
        return json(res, 200, issueTokens());
      }
      if (form.get('grant_type') === 'refresh_token') {
        const token = form.get('refresh_token') ?? '';
        if (!refreshTokens.has(token) && !(LENIENT && token.startsWith('mock-refresh-'))) return json(res, 400, { error: 'invalid_grant' });
        refreshTokens.delete(token); // rotation: the old refresh token is now dead
        return json(res, 200, issueTokens());
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }

    if (req.method === 'POST' && p === '/v2/oauth2/tokens/revoke') {
      const body = JSON.parse((await readBody(req)) || '{}') as { token?: string };
      if (body.token) {
        refreshTokens.delete(body.token);
        accessTokens.delete(body.token);
      }
      res.writeHead(200);
      return res.end();
    }

    if (req.method === 'GET' && p.startsWith('/files/')) {
      const item = store.Attachable.find((a) => a.Id === p.split('/')[2]);
      if (!item) return fault(res, 404, 'not found');
      const file = fileFor(item);
      res.writeHead(200, { 'Content-Type': file.type, 'Content-Length': String(file.body.length) });
      return res.end(file.body);
    }

    if (req.method === 'POST' && p === '/__mock/mutate') {
      const now = new Date().toISOString();
      const figma = store.Purchase.find((x) => x.Id === '1004');
      if (figma) {
        figma.PrivateNote = 'Edited in QuickBooks';
        figma.SyncToken = String(Number(figma.SyncToken) + 1);
        figma.MetaData = { ...figma.MetaData, LastUpdatedTime: now };
      }
      const idx = store.Purchase.findIndex((x) => x.Id === '1010');
      if (idx >= 0) {
        store.Purchase.splice(idx, 1);
        (deleted.Purchase ??= []).push({ Id: '1010', at: now });
      }
      return json(res, 200, { ok: true, edited: '1004', deleted: '1010' });
    }

    const api = p.match(/^\/v3\/company\/(\d+)\/(.+)$/);
    if (api) {
      if (api[1] !== MOCK_REALM_ID) return fault(res, 403, 'Unknown realm');
      const auth = String(req.headers.authorization ?? '');
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const exp = accessTokens.get(token);
      if (!(exp && exp > Date.now()) && !(LENIENT && token.startsWith('mock-access-'))) return fault(res, 401, 'AuthenticationFailed');
      requestCounter += 1;
      if (RATE_LIMIT_EVERY > 0 && requestCounter % RATE_LIMIT_EVERY === 0) {
        return fault(res, 429, 'ThrottleExceeded');
      }
      const rest = api[2];
      if (rest.startsWith('companyinfo/')) {
        return json(res, 200, { CompanyInfo: { Id: '1', CompanyName: 'Draft Sharks LLC (Mock)', Country: 'US', SyncToken: '3' }, time: new Date().toISOString() });
      }
      if (rest === 'query') {
        const result = runQuery(url.searchParams.get('query') ?? '');
        if (!result) return fault(res, 400, 'QueryParserError');
        const items = result.items.map((i) => withTempUri(result.entity, i));
        return json(res, 200, {
          QueryResponse: items.length ? { [result.entity]: items, startPosition: result.start, maxResults: items.length } : {},
          time: new Date().toISOString(),
        });
      }
      if (rest === 'cdc') {
        const entities = (url.searchParams.get('entities') ?? '').split(',').filter(Boolean);
        const since = new Date(url.searchParams.get('changedSince') ?? 0);
        if (Date.now() - since.getTime() > 30 * 86_400_000) return fault(res, 400, 'changedSince must be within 30 days');
        const qr = entities.map((entity) => {
          const changed = (store[entity] ?? []).filter((i) => new Date(i.MetaData.LastUpdatedTime) >= since).map((i) => withTempUri(entity, i));
          const gone = (deleted[entity] ?? []).filter((d) => new Date(d.at) >= since)
            .map((d) => ({ Id: d.Id, status: 'Deleted', domain: 'QBO', MetaData: { LastUpdatedTime: d.at } }));
          const list = [...changed, ...gone];
          return list.length ? { [entity]: list, startPosition: 1, maxResults: list.length } : {};
        });
        return json(res, 200, { CDCResponse: [{ QueryResponse: qr }], time: new Date().toISOString() });
      }
      const download = rest.match(/^download\/(\w+)$/);
      if (download) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end(`${BASE}/files/${download[1]}?sig=${randomBytes(6).toString('hex')}`);
      }
      return fault(res, 404, `Unsupported mock endpoint ${rest}`);
    }

    fault(res, 404, 'Not found');
  } catch (error) {
    fault(res, 500, error instanceof Error ? error.message : String(error));
  }
});

server.listen(PORT, () => {
  console.log(`QuickBooks mock listening on ${BASE} (realmId ${MOCK_REALM_ID})`);
});
