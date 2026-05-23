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
} from '@/types/domain';

export const BUSINESSES: Business[] = [
  { id: 'aurora',   name: 'Aurora Studio',     short: 'AS', color: '#D97757', hue: 24  },
  { id: 'meridian', name: 'Meridian Holdings', short: 'MH', color: '#2A6FDB', hue: 230 },
  { id: 'kiln',     name: 'Kiln Coffee Co.',   short: 'KC', color: '#1F8A5B', hue: 155 },
];

export const TRANSACTIONS: Transaction[] = [
  { id:'t01', date:'2026-05-22', dateLabel:'May 22', merchant:'Figma',               amount: -45.00,   biz:'aurora',   cat:'Software',   receipt:'matched',  src:'Amex •• 4002', note:'Annual seat — design' },
  { id:'t02', date:'2026-05-22', dateLabel:'May 22', merchant:'AWS',                 amount:-1284.13,  biz:'meridian', cat:'Cloud',      receipt:'matched',  src:'Chase •• 9981' },
  { id:'t03', date:'2026-05-22', dateLabel:'May 22', merchant:'Sweetgreen',          amount: -38.21,   biz:'aurora',   cat:'Meals',      receipt:'missing',  src:'Amex •• 4002', flag:'no-receipt' },
  { id:'t04', date:'2026-05-21', dateLabel:'May 21', merchant:'Whole Bean Roasters', amount:-2104.00,  biz:'kiln',     cat:'Inventory',  receipt:'matched',  src:'Chase •• 9981' },
  { id:'t05', date:'2026-05-21', dateLabel:'May 21', merchant:'Notion',              amount: -16.00,   biz:'aurora',   cat:'Software',   receipt:'matched',  src:'Amex •• 4002', flag:'dup-sub' },
  { id:'t06', date:'2026-05-21', dateLabel:'May 21', merchant:'Notion (annual)',     amount:-192.00,   biz:'meridian', cat:'Software',   receipt:'matched',  src:'Chase •• 9981', flag:'dup-sub' },
  { id:'t07', date:'2026-05-20', dateLabel:'May 20', merchant:'Lyft',                amount: -27.80,   biz:'aurora',   cat:'Travel',     receipt:'missing',  src:'Amex •• 4002', flag:'no-receipt' },
  { id:'t08', date:'2026-05-20', dateLabel:'May 20', merchant:'United Airlines',     amount:-612.40,   biz:'meridian', cat:'Travel',     receipt:'matched',  src:'Chase •• 9981' },
  { id:'t09', date:'2026-05-20', dateLabel:'May 20', merchant:'Hotel Yountville',    amount:-489.00,   biz:'meridian', cat:'Travel',     receipt:'matched',  src:'Chase •• 9981' },
  { id:'t10', date:'2026-05-19', dateLabel:'May 19', merchant:'Costco Business',     amount:-318.74,   biz:'kiln',     cat:'Supplies',   receipt:'matched',  src:'Amex •• 4002' },
  { id:'t11', date:'2026-05-19', dateLabel:'May 19', merchant:'Adobe',               amount: -54.99,   biz:'aurora',   cat:'Software',   receipt:'matched',  src:'Amex •• 4002' },
  { id:'t12', date:'2026-05-18', dateLabel:'May 18', merchant:'Stripe payout',       amount: 8421.10,  biz:'aurora',   cat:'Revenue',    receipt:'n/a',      src:'Chase •• 9981' },
  { id:'t13', date:'2026-05-18', dateLabel:'May 18', merchant:'Linear',              amount: -10.00,   biz:'aurora',   cat:'Software',   receipt:'matched',  src:'Amex •• 4002' },
  { id:'t14', date:'2026-05-17', dateLabel:'May 17', merchant:'Square hardware',     amount:-187.00,   biz:'kiln',     cat:'Equipment',  receipt:'pending',  src:'Chase •• 9981' },
  { id:'t15', date:'2026-05-17', dateLabel:'May 17', merchant:'Comcast Business',    amount:-129.95,   biz:'kiln',     cat:'Utilities',  receipt:'matched',  src:'Chase •• 9981' },
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
  { kind:'card',  label:'Amex Platinum',            mask:'•• 4002', status:'live',   last:'2 min ago',  txns: 312, biz:'aurora' },
  { kind:'card',  label:'Chase Sapphire',           mask:'•• 6711', status:'live',   last:'8 min ago',  txns: 88,  biz:'meridian' },
  { kind:'gmail', label:'aurora@aurora.studio',                     status:'live',   last:'just now',   txns: 47,  biz:'aurora' },
  { kind:'gmail', label:'ops@meridian.co',                          status:'live',   last:'12 min',     txns: 22,  biz:'meridian' },
  { kind:'gmail', label:'orders@kilncoffee.com',                    status:'reauth', last:'2 days ago', txns:  9,  biz:'kiln' },
];

export const ALERTS: Alert[] = [
  { id:'a1', kind:'dup',     title:'Possible duplicate subscription', detail:'Notion is billed on both Aurora ($16/mo) and Meridian ($192/yr).',  severity:'warn' },
  { id:'a2', kind:'missing', title:'3 transactions need receipts',     detail:'Sweetgreen, Lyft, and one Amex charge from May 19.',               severity:'todo' },
  { id:'a3', kind:'orphan',  title:'2 receipts without transactions',  detail:'Apple Store and Office Depot emails — likely personal cards.',    severity:'info' },
  { id:'a4', kind:'spike',   title:'Inventory spend up 22% MoM',       detail:'Kiln Coffee — Whole Bean Roasters order was 2× usual size.', severity:'info' },
];

export const SUMMARY: SpendSummary = {
  total: 0, // computed below so it stays in sync with TRANSACTIONS
  periodLabel: 'MAY',
  deltaPct: 12,
  trailingMonths: [0.42, 0.38, 0.51, 0.46, 0.55, 0.61, 0.58, 0.66, 0.71, 0.68, 0.78, 0.82],
  lastMonth: 10213,
  avgMonth: 9418,
};
SUMMARY.total = Math.abs(TRANSACTIONS.filter((t) => t.amount < 0).reduce((a, t) => a + t.amount, 0));
