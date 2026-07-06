import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

export const userRole = pgEnum('user_role', ['admin']);
export const connectionKind = pgEnum('connection_kind', ['bank', 'card', 'gmail']);
export const connectionStatus = pgEnum('connection_status', ['live', 'reauth', 'disconnected']);
export const accountKind = pgEnum('account_kind', ['checking', 'savings', 'credit', 'other']);
export const receiptStatus = pgEnum('receipt_status', ['matched', 'pending', 'missing', 'n/a', 'waived']);
export const receiptSource = pgEnum('receipt_source', ['upload', 'gmail']);
export const receiptMatchStatus = pgEnum('receipt_match_status', ['suggested', 'accepted', 'rejected', 'auto']);
export const alertKind = pgEnum('alert_kind', ['dup', 'missing', 'orphan', 'spike', 'reauth']);
export const alertSeverity = pgEnum('alert_severity', ['warn', 'todo', 'info']);
export const alertStatus = pgEnum('alert_status', ['open', 'dismissed']);
export const jobStatus = pgEnum('job_status', ['queued', 'running', 'succeeded', 'failed']);
export const exportStatus = pgEnum('export_status', ['queued', 'running', 'ready', 'failed']);

export type CategorySource =
  | 'manual'
  | 'user_confirmed_rule'
  | 'auto_rule'
  | 'plaid_signal'
  | 'ai_suggested'
  | 'receipt_evidence'
  | 'uncategorized';

export type CategorizationReviewType =
  | 'learn_rule_prompt'
  | 'ai_category_suggestion'
  | 'receipt_category_override'
  | 'rule_conflict_review';

export type CategorizationReviewStatus = 'open' | 'accepted' | 'dismissed' | 'expired';

export interface CategorizationReviewPayload {
  transactionIds?: string[];
  transactionId?: string;
  merchant?: string;
  normalizedMerchant?: string;
  currentCategoryId?: string | null;
  currentCategoryName?: string | null;
  proposedCategoryId?: string | null;
  proposedCategoryName?: string | null;
  proposedRule?: {
    matchKind: string;
    pattern: string;
    priority: number;
  };
  confidence?: number;
  evidence?: Record<string, unknown>;
  matchCounts?: {
    uncategorized: number;
    conflicts: number;
  };
}

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  username: text('username').notNull().unique(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: userRole('role').notNull().default('admin'),
  totpSecret: text('totp_secret'),
  totpEnabled: boolean('totp_enabled').notNull().default(false),
  active: boolean('active').notNull().default(true),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  ...timestamps,
});

export const sessions = pgTable('sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const businesses = pgTable('businesses', {
  id: uuid('id').defaultRandom().primaryKey(),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  short: text('short').notNull(),
  color: text('color').notNull(),
  hue: integer('hue').notNull().default(0),
  active: boolean('active').notNull().default(true),
  ...timestamps,
});

export const connections = pgTable('connections', {
  id: uuid('id').defaultRandom().primaryKey(),
  businessId: uuid('business_id').references(() => businesses.id, { onDelete: 'set null' }),
  kind: connectionKind('kind').notNull(),
  label: text('label').notNull(),
  mask: text('mask'),
  status: connectionStatus('status').notNull().default('live'),
  labelUserSet: boolean('label_user_set').notNull().default(false),
  providerItemId: text('provider_item_id'),
  gmailEmail: text('gmail_email'),
  gmailHistoryId: text('gmail_history_id'),
  gmailWatchExpiration: timestamp('gmail_watch_expiration', { withTimezone: true }),
  plaidCursor: text('plaid_cursor'),
  encryptedAccessToken: text('encrypted_access_token'),
  encryptedRefreshToken: text('encrypted_refresh_token'),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  syncedTransactionCount: integer('synced_transaction_count').notNull().default(0),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps,
}, (table) => ({
  kindIdx: index('connections_kind_idx').on(table.kind),
  providerIdx: index('connections_provider_item_idx').on(table.providerItemId),
}));

export const accounts = pgTable('accounts', {
  id: uuid('id').defaultRandom().primaryKey(),
  connectionId: uuid('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  businessId: uuid('business_id').references(() => businesses.id, { onDelete: 'set null' }),
  plaidAccountId: text('plaid_account_id'),
  kind: accountKind('kind').notNull().default('other'),
  name: text('name').notNull(),
  nickname: text('nickname'),
  officialName: text('official_name'),
  mask: text('mask'),
  enabled: boolean('enabled').notNull().default(true),
  currentBalanceCents: integer('current_balance_cents'),
  availableBalanceCents: integer('available_balance_cents'),
  ...timestamps,
}, (table) => ({
  plaidAccountIdx: uniqueIndex('accounts_plaid_account_idx').on(table.plaidAccountId),
  businessIdx: index('accounts_business_idx').on(table.businessId),
}));

export const categories = pgTable('categories', {
  id: uuid('id').defaultRandom().primaryKey(),
  businessId: uuid('business_id').references(() => businesses.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  taxCode: text('tax_code'),
  color: text('color'),
  active: boolean('active').notNull().default(true),
  ...timestamps,
}, (table) => ({
  businessNameIdx: uniqueIndex('categories_business_name_idx').on(table.businessId, table.name),
}));

export const categoryRules = pgTable('category_rules', {
  id: uuid('id').defaultRandom().primaryKey(),
  businessId: uuid('business_id').references(() => businesses.id, { onDelete: 'cascade' }),
  categoryId: uuid('category_id').notNull().references(() => categories.id, { onDelete: 'cascade' }),
  matchKind: text('match_kind').notNull(),
  pattern: text('pattern').notNull(),
  priority: integer('priority').notNull().default(100),
  createdByAi: boolean('created_by_ai').notNull().default(false),
  ...timestamps,
}, (table) => ({
  priorityIdx: index('category_rules_priority_idx').on(table.businessId, table.priority),
}));

export const receiptUploaders = pgTable('receipt_uploaders', {
  id: uuid('id').defaultRandom().primaryKey(),
  businessId: uuid('business_id').references(() => businesses.id, { onDelete: 'set null' }),
  username: text('username').notNull().unique(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  active: boolean('active').notNull().default(true),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  ...timestamps,
}, (table) => ({
  businessIdx: index('receipt_uploaders_business_idx').on(table.businessId),
}));

export const receiptUploaderSessions = pgTable('receipt_uploader_sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  uploaderId: uuid('uploader_id').notNull().references(() => receiptUploaders.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  uploaderIdx: index('receipt_uploader_sessions_uploader_idx').on(table.uploaderId),
}));

export const receipts = pgTable('receipts', {
  id: uuid('id').defaultRandom().primaryKey(),
  businessId: uuid('business_id').references(() => businesses.id, { onDelete: 'set null' }),
  source: receiptSource('source').notNull(),
  status: receiptStatus('status').notNull().default('pending'),
  merchant: text('merchant'),
  totalCents: integer('total_cents'),
  receiptDate: date('receipt_date'),
  fileKey: text('file_key'),
  fileName: text('file_name'),
  mimeType: text('mime_type'),
  fileSha256: text('file_sha256'),
  gmailMessageId: text('gmail_message_id'),
  gmailAttachmentId: text('gmail_attachment_id'),
  uploadedByUserId: uuid('uploaded_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  uploadedByUploaderId: uuid('uploaded_by_uploader_id').references(() => receiptUploaders.id, { onDelete: 'set null' }),
  transactionId: uuid('transaction_id'),
  confidence: numeric('confidence', { precision: 5, scale: 4 }),
  ocrJson: jsonb('ocr_json').$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps,
}, (table) => ({
  businessIdx: index('receipts_business_idx').on(table.businessId),
  gmailIdx: uniqueIndex('receipts_gmail_message_attachment_idx').on(table.gmailMessageId, table.gmailAttachmentId),
  uploadedByUserIdx: index('receipts_uploaded_by_user_idx').on(table.uploadedByUserId),
  uploadedByUploaderIdx: index('receipts_uploaded_by_uploader_idx').on(table.uploadedByUploaderId),
  fileSha256Idx: index('receipts_file_sha256_idx').on(table.fileSha256),
}));

export const transactions = pgTable('transactions', {
  id: uuid('id').defaultRandom().primaryKey(),
  businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
  plaidTransactionId: text('plaid_transaction_id'),
  date: date('date').notNull(),
  authorizedDate: date('authorized_date'),
  merchant: text('merchant').notNull(),
  amountCents: integer('amount_cents').notNull(),
  categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
  categorySource: text('category_source').$type<CategorySource>().notNull().default('uncategorized'),
  categoryConfidence: numeric('category_confidence', { precision: 5, scale: 4 }),
  categoryEvidence: jsonb('category_evidence').$type<Record<string, unknown>>().notNull().default({}),
  receiptId: uuid('receipt_id').references(() => receipts.id, { onDelete: 'set null' }),
  receiptStatus: receiptStatus('receipt_status').notNull().default('missing'),
  sourceLabel: text('source_label').notNull(),
  note: text('note'),
  flag: text('flag'),
  pending: boolean('pending').notNull().default(false),
  raw: jsonb('raw').$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps,
}, (table) => ({
  plaidTxnIdx: uniqueIndex('transactions_plaid_txn_idx').on(table.plaidTransactionId),
  businessDateIdx: index('transactions_business_date_idx').on(table.businessId, table.date),
  receiptStatusIdx: index('transactions_receipt_status_idx').on(table.receiptStatus),
}));

export const categorizationFeedback = pgTable('categorization_feedback', {
  id: uuid('id').defaultRandom().primaryKey(),
  businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'cascade' }),
  transactionId: uuid('transaction_id').references(() => transactions.id, { onDelete: 'set null' }),
  merchant: text('merchant').notNull(),
  normalizedMerchant: text('normalized_merchant').notNull(),
  previousCategoryId: uuid('previous_category_id').references(() => categories.id, { onDelete: 'set null' }),
  newCategoryId: uuid('new_category_id').notNull().references(() => categories.id, { onDelete: 'cascade' }),
  source: text('source').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  merchantIdx: index('categorization_feedback_merchant_idx').on(table.businessId, table.normalizedMerchant),
}));

export const categorizationReviewItems = pgTable('categorization_review_items', {
  id: uuid('id').defaultRandom().primaryKey(),
  businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'cascade' }),
  type: text('type').$type<CategorizationReviewType>().notNull(),
  status: text('status').$type<CategorizationReviewStatus>().notNull().default('open'),
  fingerprint: text('fingerprint').notNull(),
  title: text('title').notNull(),
  detail: text('detail').notNull(),
  payload: jsonb('payload').$type<CategorizationReviewPayload>().notNull().default({}),
  resolvedAction: text('resolved_action'),
  resolvedByUserId: uuid('resolved_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  ...timestamps,
}, (table) => ({
  statusIdx: index('categorization_review_items_status_idx').on(table.status, table.createdAt),
  businessStatusIdx: index('categorization_review_items_business_status_idx').on(table.businessId, table.status),
  dedupeIdx: uniqueIndex('categorization_review_items_dedupe_idx').on(
    table.businessId,
    table.type,
    table.fingerprint,
  ).where(sql`${table.status} = 'open'`),
}));

export const transactionCategoryEvents = pgTable('transaction_category_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'cascade' }),
  transactionId: uuid('transaction_id').notNull().references(() => transactions.id, { onDelete: 'cascade' }),
  previousCategoryId: uuid('previous_category_id').references(() => categories.id, { onDelete: 'set null' }),
  newCategoryId: uuid('new_category_id').references(() => categories.id, { onDelete: 'set null' }),
  source: text('source').$type<CategorySource>().notNull(),
  confidence: numeric('confidence', { precision: 5, scale: 4 }),
  evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull().default({}),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  transactionIdx: index('transaction_category_events_transaction_idx').on(table.transactionId, table.createdAt),
}));

export const receiptMatches = pgTable('receipt_matches', {
  id: uuid('id').defaultRandom().primaryKey(),
  receiptId: uuid('receipt_id').notNull().references(() => receipts.id, { onDelete: 'cascade' }),
  transactionId: uuid('transaction_id').notNull().references(() => transactions.id, { onDelete: 'cascade' }),
  score: numeric('score', { precision: 5, scale: 4 }).notNull(),
  status: receiptMatchStatus('status').notNull().default('suggested'),
  reasons: jsonb('reasons').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
}, (table) => ({
  receiptIdx: index('receipt_matches_receipt_idx').on(table.receiptId),
}));

export const alerts = pgTable('alerts', {
  id: uuid('id').defaultRandom().primaryKey(),
  businessId: uuid('business_id').references(() => businesses.id, { onDelete: 'cascade' }),
  kind: alertKind('kind').notNull(),
  severity: alertSeverity('severity').notNull(),
  title: text('title').notNull(),
  detail: text('detail').notNull(),
  status: alertStatus('status').notNull().default('open'),
  payload: jsonb('payload_json').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
}, (table) => ({
  statusIdx: index('alerts_status_idx').on(table.status),
}));

// Snapshot of transactions Plaid removed (pending→posted swaps, dedup, item revokes).
// No FKs on purpose — the live row is gone; this is the paper trail.
export const archivedTransactions = pgTable('archived_transactions', {
  id: uuid('id').defaultRandom().primaryKey(),
  originalTransactionId: uuid('original_transaction_id').notNull(),
  plaidTransactionId: text('plaid_transaction_id'),
  businessId: uuid('business_id'),
  reason: text('reason').notNull(),
  snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  plaidIdx: index('archived_transactions_plaid_idx').on(table.plaidTransactionId),
}));

export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  ip: text('ip'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  createdIdx: index('audit_logs_created_idx').on(table.createdAt),
}));

export const jobs = pgTable('jobs', {
  id: uuid('id').defaultRandom().primaryKey(),
  type: text('type').notNull(),
  status: jobStatus('status').notNull().default('queued'),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(5),
  runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  queueIdx: index('jobs_queue_idx').on(table.status, table.runAfter),
}));

export const exportJobs = pgTable('export_jobs', {
  id: uuid('id').defaultRandom().primaryKey(),
  requestedByUserId: uuid('requested_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  businessId: uuid('business_id').references(() => businesses.id, { onDelete: 'set null' }),
  dateFrom: date('date_from').notNull(),
  dateTo: date('date_to').notNull(),
  status: exportStatus('status').notNull().default('queued'),
  fileKey: text('file_key'),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Simple workspace-wide key/value settings (e.g. receipt_tracking_since).
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const businessRelations = relations(businesses, ({ many }) => ({
  connections: many(connections),
  accounts: many(accounts),
  transactions: many(transactions),
  receipts: many(receipts),
}));

export type User = typeof users.$inferSelect;
export type Business = typeof businesses.$inferSelect;
export type Connection = typeof connections.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type CategoryRule = typeof categoryRules.$inferSelect;
export type ReceiptUploader = typeof receiptUploaders.$inferSelect;
export type ReceiptUploaderSession = typeof receiptUploaderSessions.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type CategorizationFeedback = typeof categorizationFeedback.$inferSelect;
export type CategorizationReviewItem = typeof categorizationReviewItems.$inferSelect;
export type TransactionCategoryEvent = typeof transactionCategoryEvents.$inferSelect;
export type Receipt = typeof receipts.$inferSelect;
export type ReceiptMatch = typeof receiptMatches.$inferSelect;
export type Alert = typeof alerts.$inferSelect;
export type ExportJob = typeof exportJobs.$inferSelect;
