import { z } from 'zod';
import {
  ASSISTANT_MUTATION_LIMIT,
  DEFAULT_TRANSACTION_DETAIL_LIMIT,
  EXPANDED_TRANSACTION_DETAIL_LIMIT,
} from './assistantSecurity.js';

export const emptyToNull = z.string().nullable().optional().transform((value) => value === '' ? null : value);

export const transactionFilterSchema = z.object({
  business: emptyToNull.describe('Business key/id/name, or null for all businesses.'),
  from: emptyToNull.describe('YYYY-MM-DD inclusive start date.'),
  to: emptyToNull.describe('YYYY-MM-DD inclusive end date.'),
  q: emptyToNull.describe('Merchant/category/account/note search text.'),
  accountIds: z.array(z.string()).default([]),
  categories: z.array(z.string()).default([]),
  receipts: z.array(z.enum(['matched', 'pending', 'missing', 'n/a', 'waived'])).default([]),
  direction: z.enum(['all', 'inflow', 'outflow', 'operating-outflow', 'transfer']).default('all'),
});

export const queryTransactionsSchema = transactionFilterSchema.extend({
  limit: z.number().int().min(1).max(EXPANDED_TRANSACTION_DETAIL_LIMIT).default(DEFAULT_TRANSACTION_DETAIL_LIMIT),
  sort: z.enum(['date', 'amount', 'largest', 'merchant', 'business', 'category', 'account']).default('date'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});

export const cashFlowSchema = z.object({
  business: emptyToNull,
  accountIds: z.array(z.string()).default([]),
  from: emptyToNull,
  to: emptyToNull,
  group: z.enum(['month', 'year']).default('month'),
  includeTransfers: z.boolean().default(false),
});

export const ownerInsightsSchema = z.object({
  business: emptyToNull,
  accountIds: z.array(z.string()).default([]),
  from: emptyToNull,
  to: emptyToNull,
});

export const transactionUpdateSchema = z.object({
  transactionId: z.string().uuid(),
  categoryId: z.string().uuid().nullable().optional(),
  categoryName: z.string().nullable().optional(),
  businessId: z.string().uuid().nullable().optional(),
  business: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
});

export const bulkTransactionUpdateSchema = z.object({
  transactionIds: z.array(z.string().uuid()).min(1).max(ASSISTANT_MUTATION_LIMIT),
  categoryId: z.string().uuid().nullable().optional(),
  categoryName: z.string().nullable().optional(),
  businessId: z.string().uuid().nullable().optional(),
  business: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
});

export const categoryRuleSchema = z.object({
  businessId: z.string().uuid().nullable().optional(),
  business: z.string().nullable().optional(),
  categoryId: z.string().uuid(),
  matchKind: z.enum(['merchant_exact', 'merchant_contains', 'plaid_category', 'amount_range']).default('merchant_contains'),
  pattern: z.string().min(1),
  priority: z.number().int().min(1).max(999).default(10),
});

const receiptStatusFilterSchema = z.enum(['matched', 'pending', 'missing', 'n/a', 'all']);

export const queryReceiptsSchema = z.object({
  business: emptyToNull.describe('Business key/id/name, or null for all businesses.'),
  status: receiptStatusFilterSchema.nullable().default('pending'),
  source: z.enum(['upload', 'gmail', 'all']).nullable().default('all'),
  unmatched: z.boolean().default(true),
  q: emptyToNull.describe('Merchant, file name, or business search text.'),
  from: emptyToNull.describe('Receipt date YYYY-MM-DD inclusive start date.'),
  to: emptyToNull.describe('Receipt date YYYY-MM-DD inclusive end date.'),
  limit: z.number().int().min(1).max(50).default(25),
});

const receiptEditFieldsSchema = z.object({
  setMerchant: z.boolean().default(false),
  merchant: z.string().trim().min(1).max(160).nullable().optional(),
  setTotalCents: z.boolean().default(false),
  totalCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
  setReceiptDate: z.boolean().default(false),
  receiptDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

export const receiptUpdateSchema = receiptEditFieldsSchema.extend({
  receiptId: z.string().uuid(),
});

export const receiptPairingSchema = receiptEditFieldsSchema.extend({
  receiptId: z.string().uuid(),
  transactionId: z.string().uuid(),
});

export const assistantToolDefinitions = [
  functionTool('list_businesses', 'List active businesses with display colors and ids. Use before filtering when a business name is ambiguous.', z.object({})),
  functionTool('list_accounts', 'List safe Plaid account balance and sync metadata. Does not include full account numbers or tokens.', z.object({
    business: emptyToNull,
    includeDisabled: z.boolean().default(false),
  })),
  functionTool('query_transactions', `Return safe transaction rows. Default max ${DEFAULT_TRANSACTION_DETAIL_LIMIT}; more requires explicit user approval. Excludes raw Plaid payloads.`, queryTransactionsSchema),
  functionTool('get_transaction_rollup', 'Return totals/counts matching transaction filters. Use before listing rows when totals matter.', transactionFilterSchema),
  functionTool('get_cash_flow', 'Return cash-basis inflow/outflow/net periods with YoY comparison. Transfers are excluded by default.', cashFlowSchema),
  functionTool('get_owner_insights', 'Return top purchases, missing receipts, uncategorized spend, transfers, income by business, and close summary.', ownerInsightsSchema),
  functionTool('get_account_balances', 'Return current/available balances grouped into bank cash and credit cards. Historical balance trends are unavailable.', z.object({ business: emptyToNull })),
  functionTool('query_receipts', 'Return safe receipt inbox rows for matching. Does not include raw receipt files or signed download URLs.', queryReceiptsSchema),
  functionTool('propose_transaction_update', 'Prepare a single transaction edit. Does not mutate until user confirms the approval card.', transactionUpdateSchema),
  functionTool('propose_bulk_transaction_update', `Prepare a bulk transaction edit for up to ${ASSISTANT_MUTATION_LIMIT} exact ids. Does not mutate until user confirms.`, bulkTransactionUpdateSchema),
  functionTool('propose_category_rule', 'Prepare a merchant/category rule. Does not mutate until user confirms the approval card.', categoryRuleSchema),
  functionTool('propose_receipt_update', 'Prepare a receipt metadata correction for merchant, amount, or date. Set the corresponding set* flag true only for fields the user wants changed. Does not mutate until user confirms.', receiptUpdateSchema),
  functionTool('propose_receipt_pairing', 'Prepare a receipt-to-transaction pairing. Optional receipt corrections are saved before pairing. Set set* flags true only for receipt fields the user wants changed. Does not mutate until user confirms.', receiptPairingSchema),
];

export function toolEventDetail(name: string, status: 'called' | 'succeeded' | 'failed'): string {
  const verb = status === 'called' ? 'Calling' : status === 'succeeded' ? 'Finished' : 'Tool failed';
  const labels: Record<string, string> = {
    list_businesses: 'business lookup',
    list_accounts: 'account balance lookup',
    query_transactions: 'transaction search',
    get_transaction_rollup: 'transaction totals',
    get_cash_flow: 'cash-flow report',
    get_owner_insights: 'owner insights',
    get_account_balances: 'balance report',
    query_receipts: 'receipt inbox search',
    propose_transaction_update: 'transaction edit proposal',
    propose_bulk_transaction_update: 'bulk edit proposal',
    propose_category_rule: 'category rule proposal',
    propose_receipt_update: 'receipt edit proposal',
    propose_receipt_pairing: 'receipt pairing proposal',
  };
  return `${verb} ${labels[name] ?? name}.`;
}

function functionTool(name: string, description: string, schema: z.ZodTypeAny) {
  return {
    type: 'function' as const,
    name,
    description,
    parameters: zodToJsonSchema(name, schema),
    strict: true,
  };
}

function zodToJsonSchema(name: string, _schema: z.ZodTypeAny) {
  const all = { type: ['string', 'null'] as const };
  const list = { type: 'array', items: { type: 'string' } };
  const bool = { type: 'boolean' as const };
  const int = { type: 'integer' as const };
  const nullableInt = { type: ['integer', 'null'] as const };
  const receiptEditProperties = {
    setMerchant: bool,
    merchant: all,
    setTotalCents: bool,
    totalCents: nullableInt,
    setReceiptDate: bool,
    receiptDate: all,
  };
  const commonFilters = {
    business: all,
    from: all,
    to: all,
    q: all,
    accountIds: list,
    categories: list,
    receipts: { type: 'array', items: { type: 'string', enum: ['matched', 'pending', 'missing', 'n/a'] }, default: [] },
    direction: { type: 'string', enum: ['all', 'inflow', 'outflow', 'operating-outflow', 'transfer'] },
  };
  const schemas: Record<string, Record<string, unknown>> = {
    list_businesses: {},
    list_accounts: { business: all, includeDisabled: bool },
    query_transactions: {
      ...commonFilters,
      limit: { ...int, minimum: 1, maximum: EXPANDED_TRANSACTION_DETAIL_LIMIT },
      sort: { type: 'string', enum: ['date', 'amount', 'largest', 'merchant', 'business', 'category', 'account'] },
      dir: { type: 'string', enum: ['asc', 'desc'] },
    },
    get_transaction_rollup: commonFilters,
    get_cash_flow: {
      business: all,
      accountIds: list,
      from: all,
      to: all,
      group: { type: 'string', enum: ['month', 'year'] },
      includeTransfers: bool,
    },
    get_owner_insights: { business: all, accountIds: list, from: all, to: all },
    get_account_balances: { business: all },
    query_receipts: {
      business: all,
      status: { type: ['string', 'null'], enum: ['matched', 'pending', 'missing', 'n/a', 'all', null] },
      source: { type: ['string', 'null'], enum: ['upload', 'gmail', 'all', null] },
      unmatched: bool,
      q: all,
      from: all,
      to: all,
      limit: { ...int, minimum: 1, maximum: 50 },
    },
    propose_transaction_update: {
      transactionId: { type: 'string' },
      categoryId: all,
      categoryName: all,
      businessId: all,
      business: all,
      note: all,
    },
    propose_bulk_transaction_update: {
      transactionIds: list,
      categoryId: all,
      categoryName: all,
      businessId: all,
      business: all,
      note: all,
    },
    propose_category_rule: {
      businessId: all,
      business: all,
      categoryId: { type: 'string' },
      matchKind: { type: 'string', enum: ['merchant_exact', 'merchant_contains', 'plaid_category', 'amount_range'] },
      pattern: { type: 'string' },
      priority: { ...int, minimum: 1, maximum: 999 },
    },
    propose_receipt_update: {
      receiptId: { type: 'string' },
      ...receiptEditProperties,
    },
    propose_receipt_pairing: {
      receiptId: { type: 'string' },
      transactionId: { type: 'string' },
      ...receiptEditProperties,
    },
  };
  const properties = schemas[name] ?? {};
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}
