// The fixture set every tile reads while the real backend is being built.
// Mirrors the design's shared-data.jsx so the UI matches the mock exactly.
//
// Delete this file once VITE_USE_MOCK_API is false in every environment.

import type {
  Alert,
  Business,
  Category,
  Connection,
  SpendSummary,
  Transaction,
  Account,
} from '@/types/domain';

export const BUSINESSES: Business[] = [
  { id: 'draft-sharks', name: 'Draft Sharks', short: 'DS', color: '#D97757', hue: 24 },
  { id: 'pointsnav', name: 'PointsNav', short: 'PN', color: '#2A6FDB', hue: 230 },
  { id: 'womens-net', name: 'Womens Net', short: 'WN', color: '#1F8A5B', hue: 155 },
];

export const TRANSACTIONS: Transaction[] = [
  { id:'t01', accountId:'acct-1', date:'2026-05-22', dateLabel:'May 22', merchant:'Figma', amount: -45.00, biz:'draft-sharks', cat:'Software', receipt:'matched', src:'Amex ** 4002', note:'Design seats' },
  { id:'t02', accountId:'acct-2', date:'2026-05-22', dateLabel:'May 22', merchant:'AWS', amount:-1284.13, biz:'pointsnav', cat:'Cloud', receipt:'matched', src:'Chase ** 6711' },
  { id:'t03', accountId:'acct-1', date:'2026-05-22', dateLabel:'May 22', merchant:'Sweetgreen', amount: -38.21, biz:'draft-sharks', cat:'Meals', receipt:'missing', src:'Amex ** 4002', flag:'no-receipt' },
  { id:'t04', accountId:'acct-3', date:'2026-05-21', dateLabel:'May 21', merchant:'Tournament Gear', amount:-2104.00, biz:'womens-net', cat:'Inventory', receipt:'matched', src:'Chase ** 9981' },
  { id:'t05', accountId:'acct-1', date:'2026-05-21', dateLabel:'May 21', merchant:'Notion', amount: -16.00, biz:'draft-sharks', cat:'Software', receipt:'matched', src:'Amex ** 4002', flag:'dup-sub' },
  { id:'t06', accountId:'acct-2', date:'2026-05-21', dateLabel:'May 21', merchant:'Notion (annual)', amount:-192.00, biz:'pointsnav', cat:'Software', receipt:'matched', src:'Chase ** 6711', flag:'dup-sub' },
  { id:'t07', accountId:'acct-1', date:'2026-05-20', dateLabel:'May 20', merchant:'Lyft', amount: -27.80, biz:'draft-sharks', cat:'Travel', receipt:'missing', src:'Amex ** 4002', flag:'no-receipt' },
  { id:'t08', accountId:'acct-2', date:'2026-05-20', dateLabel:'May 20', merchant:'United Airlines', amount:-612.40, biz:'pointsnav', cat:'Travel', receipt:'matched', src:'Chase ** 6711' },
  { id:'t09', accountId:'acct-2', date:'2026-05-20', dateLabel:'May 20', merchant:'Hotel Yountville', amount:-489.00, biz:'pointsnav', cat:'Travel', receipt:'matched', src:'Chase ** 6711' },
  { id:'t10', accountId:'acct-3', date:'2026-05-19', dateLabel:'May 19', merchant:'Costco Business', amount:-318.74, biz:'womens-net', cat:'Supplies', receipt:'matched', src:'Chase ** 9981' },
  { id:'t11', accountId:'acct-1', date:'2026-05-19', dateLabel:'May 19', merchant:'Adobe', amount: -54.99, biz:'draft-sharks', cat:'Software', receipt:'matched', src:'Amex ** 4002' },
  { id:'t12', date:'2026-05-18', dateLabel:'May 18', merchant:'Stripe payout', amount: 8421.10, biz:'draft-sharks', cat:'Revenue', receipt:'n/a', src:'Stripe' },
  { id:'t13', accountId:'acct-1', date:'2026-05-18', dateLabel:'May 18', merchant:'Linear', amount: -10.00, biz:'draft-sharks', cat:'Software', receipt:'matched', src:'Amex ** 4002' },
  { id:'t14', accountId:'acct-3', date:'2026-05-17', dateLabel:'May 17', merchant:'Square hardware', amount:-187.00, biz:'womens-net', cat:'Equipment', receipt:'pending', src:'Chase ** 9981' },
  { id:'t15', accountId:'acct-3', date:'2026-05-17', dateLabel:'May 17', merchant:'Comcast Business', amount:-129.95, biz:'womens-net', cat:'Utilities', receipt:'matched', src:'Chase ** 9981' },
];

export const CATEGORIES: Category[] = [
  { name:'Software',  amount: 2418, delta:'+12%', count: 14 },
  { name:'Cloud',     amount: 1284, delta:'+3%',  count: 1  },
  { name:'Travel',    amount: 1129, delta:'-8%',  count: 6  },
  { name:'Inventory', amount: 2104, delta:'+22%', count: 2  },
  { name:'Meals',     amount:  642, delta:'+4%',  count: 11 },
  { name:'Supplies',  amount:  318, delta:'-15%', count: 3  },
  { name:'Utilities', amount:  129, delta:'+0%',  count: 1  },
];

export const CONNECTIONS: Connection[] = [
  { kind:'bank',  label:'Chase Business',           mask:'•• 9981', status:'live',   last:'2 min ago',  txns: 124, biz:'all' },
  { kind:'card',  label:'Amex Platinum',            mask:'•• 4002', status:'live',   last:'2 min ago',  txns: 312, biz:'draft-sharks' },
  { kind:'card',  label:'Chase Sapphire',           mask:'•• 6711', status:'live',   last:'8 min ago',  txns: 88,  biz:'pointsnav' },
  { kind:'gmail', label:'receipts@draftsharks.com',                 status:'live',   last:'just now',   txns: 47,  biz:'draft-sharks' },
  { kind:'gmail', label:'ops@pointsnav.com',                         status:'live',   last:'12 min',     txns: 22,  biz:'pointsnav' },
  { kind:'gmail', label:'receipts@womensnet.com',                    status:'reauth', last:'2 days ago', txns:  9,  biz:'womens-net' },
];

export const ACCOUNTS: Account[] = [
  { id: 'acct-1', connectionId: 'conn-1', name: 'Amex Platinum', mask: '** 4002', kind: 'credit', enabled: true, biz: 'draft-sharks', businessId: 'draft-sharks', connectionLabel: 'Amex Platinum', connectionStatus: 'live' },
  { id: 'acct-2', connectionId: 'conn-2', name: 'Chase Sapphire', mask: '** 6711', kind: 'credit', enabled: true, biz: 'pointsnav', businessId: 'pointsnav', connectionLabel: 'Chase Sapphire', connectionStatus: 'live' },
  { id: 'acct-3', connectionId: 'conn-3', name: 'Operations Checking', mask: '** 9981', kind: 'checking', enabled: true, biz: 'womens-net', businessId: 'womens-net', connectionLabel: 'Chase Business', connectionStatus: 'live' },
];

export function visibleMockTransactions(rows: Transaction[] = TRANSACTIONS, accountIds: string[] = []): Transaction[] {
  const watched = new Set(ACCOUNTS.filter((account) => account.enabled).map((account) => account.id));
  return rows
    .filter((txn) => !txn.accountId || watched.has(txn.accountId))
    .filter((txn) => accountIds.length === 0 || Boolean(txn.accountId && accountIds.includes(txn.accountId)));
}

export const ALERTS: Alert[] = [
  { id:'a1', kind:'dup',     title:'Possible duplicate subscription', detail:'Notion is billed on both Draft Sharks ($16/mo) and PointsNav ($192/yr).',  severity:'warn' },
  { id:'a2', kind:'missing', title:'3 transactions need receipts',     detail:'Sweetgreen, Lyft, and one Amex charge from May 19.',               severity:'todo' },
  { id:'a3', kind:'orphan',  title:'2 receipts without transactions',  detail:'Apple Store and Office Depot emails — likely personal cards.',    severity:'info' },
  { id:'a4', kind:'spike',   title:'Equipment spend up 22% MoM',       detail:'Womens Net equipment order was 2x usual size.', severity:'info' },
];

export const SUMMARY: SpendSummary = {
  total: 0, // computed below so it stays in sync with TRANSACTIONS
  periodLabel: 'MAY',
  deltaPct: 12,
  trailingMonths: [0.42, 0.38, 0.51, 0.46, 0.55, 0.61, 0.58, 0.66, 0.71, 0.68, 0.78, 0.82],
  lastMonth: 10213,
  avgMonth: 9418,
};
SUMMARY.total = Math.abs(visibleMockTransactions(TRANSACTIONS).filter((t) => t.amount < 0).reduce((a, t) => a + t.amount, 0));
