// The fixture set every tile reads while the real backend is being built.
// Mirrors the design's shared-data.jsx so the UI matches the mock exactly.
//
// Delete this file once VITE_USE_MOCK_API is false in every environment.

import type {
  Business,
  CategorizationReviewItem,
  Category,
  Connection,
  SpendSummary,
  Tag,
  TagRule,
  TagTrendSeries,
  Transaction,
  Account,
} from '@/types/domain';
import { isSpendTransaction } from '@/lib/calc';
import { parseLocalIsoDate, toLocalIsoDate } from '@/lib/dates';
import type { AlertItem } from './alerts';

export const BUSINESSES: Business[] = [
  { id: 'draft-sharks', name: 'Draft Sharks', short: 'DS', color: '#D97757', hue: 24 },
  { id: 'pointsnav', name: 'PointsNav', short: 'PN', color: '#2A6FDB', hue: 230 },
  { id: 'womens-net', name: 'Womens Net', short: 'WN', color: '#1F8A5B', hue: 155 },
];

// Fixture dates are relative to today so every screen (month-to-date pace, 12-month
// reports, month close) has data whenever the mock app is opened.
const MOCK_TODAY = new Date();
MOCK_TODAY.setHours(0, 0, 0, 0);

function mockIso(date: Date): string {
  return toLocalIsoDate(date);
}

function daysAgo(days: number): string {
  const date = new Date(MOCK_TODAY);
  date.setDate(date.getDate() - days);
  return mockIso(date);
}

function mockDateLabel(iso: string): string {
  return parseLocalIsoDate(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

type MockTxn = Omit<Transaction, 'dateLabel'>;

const SUBSCRIPTIONS_TAG = { id: 'tag-subscriptions', name: 'Subscriptions', color: '#2A6FDB', source: 'auto' as const };
const AI_TAG = { id: 'tag-ai', name: 'AI', color: '#7C5CFF', source: 'auto' as const };

// The recent, hand-written rows (the ones the receipts / review fixtures point at).
const RECENT: MockTxn[] = [
  { id:'t01', accountId:'acct-1', date:daysAgo(0), merchant:'Figma', amount: -45.00, biz:'draft-sharks', cat:'Software', receipt:'matched', src:'Amex ** 4002', note:'Design seats', tags:[SUBSCRIPTIONS_TAG] },
  { id:'t00', accountId:'acct-1', date:daysAgo(0), merchant:'OpenAI', amount: -120.00, biz:'draft-sharks', cat:'Software', receipt:'matched', src:'Amex ** 4002', note:'API usage', tags:[AI_TAG] },
  { id:'t02', accountId:'acct-2', date:daysAgo(0), merchant:'AWS', amount:-1284.13, biz:'pointsnav', cat:'Cloud', receipt:'matched', src:'Chase ** 6711' },
  { id:'t03', accountId:'acct-1', date:daysAgo(0), merchant:'Sweetgreen', amount: -38.21, biz:'draft-sharks', cat:'Meals', receipt:'missing', src:'Amex ** 4002', flag:'no-receipt' },
  { id:'t04', accountId:'acct-3', date:daysAgo(1), merchant:'Tournament Gear', amount:-2104.00, biz:'womens-net', cat:'Inventory', receipt:'matched', src:'Chase ** 9981' },
  { id:'t05', accountId:'acct-1', date:daysAgo(1), merchant:'Notion', amount: -16.00, biz:'draft-sharks', cat:'Software', receipt:'matched', src:'Amex ** 4002', flag:'dup-sub', tags:[SUBSCRIPTIONS_TAG, { ...AI_TAG, source:'manual' }] },
  { id:'t06', accountId:'acct-2', date:daysAgo(1), merchant:'Notion (annual)', amount:-192.00, biz:'pointsnav', cat:'Software', receipt:'matched', src:'Chase ** 6711', flag:'dup-sub' },
  { id:'t07', accountId:'acct-1', date:daysAgo(2), merchant:'Lyft', amount: -27.80, biz:'draft-sharks', cat:'Travel', receipt:'missing', src:'Amex ** 4002', flag:'no-receipt' },
  { id:'t08', accountId:'acct-2', date:daysAgo(2), merchant:'United Airlines', amount:-612.40, biz:'pointsnav', cat:'Travel', receipt:'matched', src:'Chase ** 6711' },
  { id:'t09', accountId:'acct-2', date:daysAgo(2), merchant:'Hotel Yountville', amount:-489.00, biz:'pointsnav', cat:'Travel', receipt:'matched', src:'Chase ** 6711' },
  { id:'t10', accountId:'acct-3', date:daysAgo(3), merchant:'Costco Business', amount:-318.74, biz:'womens-net', cat:'Supplies', receipt:'matched', src:'Chase ** 9981' },
  { id:'t11', accountId:'acct-1', date:daysAgo(3), merchant:'Adobe', amount: -54.99, biz:'draft-sharks', cat:'Software', receipt:'matched', src:'Amex ** 4002' },
  { id:'t12', date:daysAgo(4), merchant:'Stripe payout', amount: 8421.10, biz:'draft-sharks', cat:'Revenue', receipt:'n/a', src:'Stripe' },
  { id:'t13', accountId:'acct-1', date:daysAgo(4), merchant:'Linear', amount: -10.00, biz:'draft-sharks', cat:'Software', receipt:'matched', src:'Amex ** 4002' },
  { id:'t14', accountId:'acct-3', date:daysAgo(5), merchant:'Square hardware', amount:-187.00, biz:'womens-net', cat:'Equipment', receipt:'pending', src:'Chase ** 9981' },
  { id:'t15', accountId:'acct-3', date:daysAgo(5), merchant:'Comcast Business', amount:-129.95, biz:'womens-net', cat:'Utilities', receipt:'matched', src:'Chase ** 9981' },
  { id:'t16', accountId:'acct-1', date:daysAgo(1), merchant:'SQ *BLUE BOTTLE 0412', amount: -64.50, biz:'draft-sharks', cat:'Uncategorized', receipt:'missing', src:'Amex ** 4002' },
  // Waived by the "Starbucks" merchant rule in the receipt-workflow mock (api/receiptWorkflow.ts).
  { id:'t17', accountId:'acct-1', date:daysAgo(2), merchant:'Starbucks', amount: -6.45, biz:'draft-sharks', cat:'Meals', receipt:'waived', src:'Amex ** 4002' },
];

interface MonthlyTemplate {
  merchant: string;
  biz: string;
  cat: string;
  day: number;
  amount: number;
  accountId?: string;
  src: string;
  /** Emit only every Nth month. */
  every?: number;
  tags?: Transaction['tags'];
}

// Recurring history for the 13 months before the recent rows: enough for 12-month reports,
// the month-close checklist and last month's pace line.
const MONTHLY: MonthlyTemplate[] = [
  { merchant:'Stripe payout', biz:'draft-sharks', cat:'Revenue', day:1, amount: 8200, src:'Stripe' },
  { merchant:'Stripe payout', biz:'draft-sharks', cat:'Revenue', day:15, amount: 7600, src:'Stripe' },
  { merchant:'Impact affiliate payout', biz:'pointsnav', cat:'Revenue', day:10, amount: 5400, src:'Chase ** 6711' },
  { merchant:'Sponsorship — League Pass', biz:'womens-net', cat:'Revenue', day:20, amount: 4300, accountId:'acct-3', src:'Chase ** 9981' },
  { merchant:'AWS', biz:'pointsnav', cat:'Cloud', day:2, amount: -1180, accountId:'acct-2', src:'Chase ** 6711' },
  { merchant:'Figma', biz:'draft-sharks', cat:'Software', day:3, amount: -45, accountId:'acct-1', src:'Amex ** 4002', tags:[SUBSCRIPTIONS_TAG] },
  { merchant:'OpenAI', biz:'draft-sharks', cat:'Software', day:5, amount: -96, accountId:'acct-1', src:'Amex ** 4002', tags:[AI_TAG] },
  { merchant:'Anthropic', biz:'pointsnav', cat:'Software', day:6, amount: -140, accountId:'acct-2', src:'Chase ** 6711', tags:[AI_TAG] },
  { merchant:'Costco Business', biz:'womens-net', cat:'Supplies', day:8, amount: -290, accountId:'acct-3', src:'Chase ** 9981' },
  { merchant:'Sweetgreen', biz:'draft-sharks', cat:'Meals', day:9, amount: -34, accountId:'acct-1', src:'Amex ** 4002' },
  { merchant:'United Airlines', biz:'pointsnav', cat:'Travel', day:12, amount: -540, accountId:'acct-2', src:'Chase ** 6711', every:2 },
  { merchant:'Tournament Gear', biz:'womens-net', cat:'Inventory', day:14, amount: -1650, accountId:'acct-3', src:'Chase ** 9981' },
  { merchant:'Upwork contractors', biz:'pointsnav', cat:'Contractors', day:16, amount: -2400, accountId:'acct-2', src:'Chase ** 6711' },
  { merchant:'Comcast Business', biz:'womens-net', cat:'Utilities', day:17, amount: -129.95, accountId:'acct-3', src:'Chase ** 9981' },
  { merchant:'Adobe', biz:'draft-sharks', cat:'Software', day:19, amount: -54.99, accountId:'acct-1', src:'Amex ** 4002' },
  { merchant:'Notion', biz:'draft-sharks', cat:'Software', day:21, amount: -16, accountId:'acct-1', src:'Amex ** 4002', tags:[SUBSCRIPTIONS_TAG] },
  { merchant:'Google Ads', biz:'draft-sharks', cat:'Advertising', day:24, amount: -880, accountId:'acct-1', src:'Amex ** 4002' },
  { merchant:'Transfer to savings', biz:'womens-net', cat:'Transfers', day:25, amount: -2000, accountId:'acct-3', src:'Chase ** 9981' },
  { merchant:'Uber Eats', biz:'pointsnav', cat:'Meals', day:26, amount: -48, accountId:'acct-2', src:'Chase ** 6711' },
];

function buildHistory(): MockTxn[] {
  const rows: MockTxn[] = [];
  const recentCutoff = daysAgo(5);
  for (let monthsBack = 0; monthsBack <= 13; monthsBack += 1) {
    const monthStart = new Date(MOCK_TODAY.getFullYear(), MOCK_TODAY.getMonth() - monthsBack, 1);
    const lastDay = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate();
    MONTHLY.forEach((template, index) => {
      if (template.every && monthsBack % template.every !== 0) return;
      const date = mockIso(new Date(monthStart.getFullYear(), monthStart.getMonth(), Math.min(template.day, lastDay)));
      // The recent hand-written rows own the last few days.
      if (date >= recentCutoff) return;
      // Deterministic wobble so months differ without randomness.
      const factor = 1 + 0.14 * Math.sin(monthsBack * 1.7 + index * 0.9);
      const amount = Math.round(template.amount * factor * 100) / 100;
      const receipt: Transaction['receipt'] = amount > 0
        ? 'n/a'
        : template.cat === 'Transfers'
          ? 'n/a'
          : monthsBack === 0 && index % 3 === 0 ? 'missing' : monthsBack === 1 && index % 7 === 0 ? 'missing' : 'matched';
      rows.push({
        id: `m${monthsBack}-${index}`,
        accountId: template.accountId,
        date,
        merchant: template.merchant,
        amount,
        biz: template.biz,
        cat: template.cat,
        receipt,
        src: template.src,
        tags: template.tags,
      });
    });
  }
  return rows;
}

export const TRANSACTIONS: Transaction[] = [...RECENT, ...buildHistory()]
  .map((row) => ({ ...row, dateLabel: mockDateLabel(row.date) }))
  .sort((a, b) => b.date.localeCompare(a.date));

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
  { id: 'acct-1', connectionId: 'conn-1', name: 'Amex Platinum', mask: '** 4002', kind: 'credit', enabled: true, biz: 'draft-sharks', businessId: 'draft-sharks', currentBalanceCents: 1842067, availableBalanceCents: 4200000, connectionLabel: 'Amex Platinum', connectionStatus: 'live', connectionLastSyncAt: new Date(Date.now() - 12 * 60_000).toISOString() },
  { id: 'acct-2', connectionId: 'conn-2', name: 'Chase Sapphire', mask: '** 6711', kind: 'credit', enabled: true, biz: 'pointsnav', businessId: 'pointsnav', currentBalanceCents: 726120, availableBalanceCents: 2100000, connectionLabel: 'Chase Sapphire', connectionStatus: 'live', connectionLastSyncAt: new Date(Date.now() - 25 * 60_000).toISOString() },
  { id: 'acct-3', connectionId: 'conn-3', name: 'Operations Checking', mask: '** 9981', kind: 'checking', enabled: true, biz: 'womens-net', businessId: 'womens-net', currentBalanceCents: 24890142, availableBalanceCents: 24890142, connectionLabel: 'Chase Business', connectionStatus: 'live', connectionLastSyncAt: new Date(Date.now() - 14 * 60_000).toISOString() },
];

export function visibleMockTransactions(rows: Transaction[] = TRANSACTIONS, accountIds: string[] = []): Transaction[] {
  const watched = new Set(ACCOUNTS.filter((account) => account.enabled).map((account) => account.id));
  return rows
    .filter((txn) => !txn.accountId || watched.has(txn.accountId))
    .filter((txn) => accountIds.length === 0 || Boolean(txn.accountId && accountIds.includes(txn.accountId)));
}

export const ALERTS: AlertItem[] = [
  { id:'a1', kind:'dup',     biz: null,         title:'Possible duplicate subscription: Notion', detail:'Notion is billed across 2 businesses in the last 45 days.', severity:'warn' },
  { id:'a2', kind:'missing', biz:'draft-sharks', title:'3 transactions need receipts',          detail:'Transactions are past the 7-day receipt SLA.',             severity:'todo' },
  { id:'a3', kind:'orphan',  biz:'pointsnav',    title:'2 receipts without transactions',       detail:'Receipts have not matched a transaction after 14 days.',    severity:'info' },
  { id:'a4', kind:'spike',   biz:'womens-net',   title:'Equipment spend up 122% this month',    detail:'Womens Net: $2,104 so far vs $947 last month.',              severity:'info' },
];

export const SUMMARY: SpendSummary = {
  total: 0, // computed below so it stays in sync with TRANSACTIONS
  periodLabel: 'MAY',
  deltaPct: 12,
  trailingMonths: [0.42, 0.38, 0.51, 0.46, 0.55, 0.61, 0.58, 0.66, 0.71, 0.68, 0.78, 0.82],
  trailingMonthLabels: ['Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May'],
  trailingMonthCents: [420000, 380000, 510000, 460000, 550000, 610000, 580000, 660000, 710000, 680000, 780000, 820000],
  trailingOutflowMonthCents: [420000, 380000, 510000, 460000, 550000, 610000, 580000, 660000, 710000, 680000, 780000, 820000],
  trailingInflowMonthCents: [690000, 710000, 650000, 780000, 720000, 810000, 760000, 840000, 890000, 1388119, 820000, 960000],
  trailingNetMonthCents: [270000, 330000, 140000, 320000, 170000, 200000, 180000, 180000, 180000, 708119, 40000, 140000],
  lastMonth: 10213,
  lastInflow: 8200,
  lastOutflow: 10213,
  lastNet: -2013,
  avgMonth: 9418,
  avgInflow: 8134,
  avgOutflow: 9418,
  avgNet: -1284,
};
SUMMARY.trailingMonthBusinessCents = SUMMARY.trailingMonthCents?.map((total, index) => {
  const draft = Math.round(total * (0.42 + (index % 3) * 0.04));
  const points = Math.round(total * (0.28 + (index % 2) * 0.03));
  const womens = Math.max(0, total - draft - points);
  return [
    { businessId: 'draft-sharks', businessName: 'Draft Sharks', color: BUSINESSES[0].color, cents: draft },
    { businessId: 'pointsnav', businessName: 'PointsNav', color: BUSINESSES[1].color, cents: points },
    { businessId: 'womens-net', businessName: 'Womens Net', color: BUSINESSES[2].color, cents: womens },
  ];
});
SUMMARY.trailingOutflowBusinessCents = SUMMARY.trailingMonthBusinessCents;
SUMMARY.trailingInflowBusinessCents = SUMMARY.trailingInflowMonthCents?.map((total, index) => {
  const draft = Math.round(total * (0.58 + (index % 2) * 0.03));
  const points = Math.round(total * (0.24 + (index % 3) * 0.02));
  const womens = Math.max(0, total - draft - points);
  return [
    { businessId: 'draft-sharks', businessName: 'Draft Sharks', color: BUSINESSES[0].color, cents: draft },
    { businessId: 'pointsnav', businessName: 'PointsNav', color: BUSINESSES[1].color, cents: points },
    { businessId: 'womens-net', businessName: 'Womens Net', color: BUSINESSES[2].color, cents: womens },
  ];
});
SUMMARY.total = Math.abs(visibleMockTransactions(TRANSACTIONS).filter(isSpendTransaction).reduce((a, t) => a + t.amount, 0));
SUMMARY.outflow = SUMMARY.total;
SUMMARY.inflow = Math.abs(visibleMockTransactions(TRANSACTIONS).filter((txn) => txn.amount > 0).reduce((a, t) => a + t.amount, 0));
SUMMARY.net = SUMMARY.inflow - SUMMARY.outflow;

export const TAGS: Tag[] = [
  { id: 'tag-ai', name: 'AI', color: '#7C5CFF', active: true },
  { id: 'tag-subscriptions', name: 'Subscriptions', color: '#2A6FDB', active: true },
];
// Counts/spend derived from TRANSACTIONS so the mock stays self-consistent.
for (const tag of TAGS) {
  const tagged = TRANSACTIONS.filter((txn) => txn.tags?.some((t) => t.id === tag.id));
  tag.txnCount = tagged.length;
  tag.totalCents = Math.round(tagged.filter((txn) => txn.amount < 0).reduce((sum, txn) => sum - txn.amount, 0) * 100);
}

export const TAG_RULES: TagRule[] = [
  { id: 'tag-rule-1', tagId: 'tag-ai', matchKind: 'merchant_contains', pattern: 'openai' },
  { id: 'tag-rule-2', tagId: 'tag-ai', matchKind: 'merchant_contains', pattern: 'anthropic' },
  { id: 'tag-rule-3', tagId: 'tag-subscriptions', matchKind: 'merchant_contains', pattern: 'figma' },
  { id: 'tag-rule-4', tagId: 'tag-subscriptions', matchKind: 'merchant_contains', pattern: 'notion' },
];

/** Monthly outflow per tag over [from, to], computed from the fixture transactions. */
export function mockTagTrends(tagIds: string[], from?: string, to?: string): TagTrendSeries[] {
  const end = to ?? toLocalIsoDate(MOCK_TODAY);
  const endDate = parseLocalIsoDate(end);
  const start = from ?? toLocalIsoDate(new Date(endDate.getFullYear(), endDate.getMonth() - 11, 1));
  const startDate = parseLocalIsoDate(start);
  const months: string[] = [];
  for (let cursor = new Date(startDate.getFullYear(), startDate.getMonth(), 1); cursor <= endDate; cursor.setMonth(cursor.getMonth() + 1)) {
    months.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`);
  }
  return TAGS.filter((tag) => tagIds.includes(tag.id)).map((tag) => ({
    tagId: tag.id,
    name: tag.name,
    color: tag.color,
    points: months.map((month) => {
      const rows = TRANSACTIONS.filter((txn) => (
        txn.amount < 0
        && txn.date.startsWith(month)
        && txn.date >= start
        && txn.date <= end
        && txn.tags?.some((item) => item.id === tag.id)
      ));
      return {
        month,
        totalCents: Math.round(rows.reduce((sum, txn) => sum - txn.amount, 0) * 100),
        count: rows.length,
      };
    }),
  }));
}

/** Open categorization reviews shown in Home › Needs you (resolving one removes it). */
export const MOCK_REVIEW_ITEMS: CategorizationReviewItem[] = [
  {
    id: 'review-blue-bottle',
    businessId: 'mock-ds',
    biz: 'draft-sharks',
    type: 'ai_category_suggestion',
    status: 'open',
    title: 'SQ *BLUE BOTTLE looks like Meals',
    detail: 'Coffee shop charge on the Amex; similar merchants are categorized as Meals.',
    payload: { merchant: 'SQ *BLUE BOTTLE 0412', transactionIds: ['t16'], proposedCategoryName: 'Meals', confidence: 0.88 },
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
  },
  {
    id: 'review-upwork-rule',
    businessId: 'mock-pn',
    biz: 'pointsnav',
    type: 'learn_rule_prompt',
    status: 'open',
    title: 'Always file Upwork as Contractors?',
    detail: 'You recategorized Upwork 3 times. Create a rule so future charges are filed automatically.',
    payload: {
      merchant: 'Upwork contractors',
      proposedCategoryName: 'Contractors',
      proposedRule: { matchKind: 'merchant_contains', pattern: 'upwork', priority: 100 },
      matchCounts: { uncategorized: 0, conflicts: 0 },
    },
    createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    updatedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  },
];
