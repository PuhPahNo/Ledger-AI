-- Read-only QuickBooks Online integration (one QBO company per existing business).
-- Non-destructive: two enum values and new tables only. Safe to re-run.
--
-- The migrator wraps each file in BEGIN/COMMIT. ALTER TYPE ... ADD VALUE is allowed inside a
-- transaction block on PostgreSQL 12+ as long as the new value is not USED in the same
-- transaction — nothing below references 'quickbooks' as a literal (no defaults, checks or
-- partial-index predicates), so this file is safe. (PostgreSQL < 12 would reject it; Render
-- Postgres is 15+.)
ALTER TYPE connection_kind ADD VALUE IF NOT EXISTS 'quickbooks';
ALTER TYPE receipt_source ADD VALUE IF NOT EXISTS 'quickbooks';

-- Per-company sync state. The connection row (kind 'quickbooks') holds the encrypted tokens;
-- this row holds the realm, token expiries and CDC cursor. One active company per business,
-- and one business per active realm.
CREATE TABLE IF NOT EXISTS qbo_companies (
  connection_id uuid PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  realm_id text NOT NULL,
  company_name text,
  environment text NOT NULL DEFAULT 'production',
  active boolean NOT NULL DEFAULT true,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  last_token_refresh_at timestamptz,
  history_start_date date,
  last_full_sync_at timestamptz,
  last_cdc_at timestamptz,
  last_sync_started_at timestamptz,
  last_sync_error text,
  last_sync_stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS qbo_companies_active_business_idx ON qbo_companies (business_id) WHERE active;
CREATE UNIQUE INDEX IF NOT EXISTS qbo_companies_active_realm_idx ON qbo_companies (realm_id) WHERE active;

-- Chart of accounts. Bank/credit-card accounts map to Ledger accounts (for linking);
-- expense accounts map to Ledger categories (category signal).
CREATE TABLE IF NOT EXISTS qbo_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  qbo_id text NOT NULL,
  name text NOT NULL,
  fully_qualified_name text,
  account_type text,
  account_sub_type text,
  classification text,
  acct_num_last4 text,
  active boolean NOT NULL DEFAULT true,
  deleted boolean NOT NULL DEFAULT false,
  current_balance_cents bigint,
  ledger_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  ledger_account_method text,
  ledger_category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  ledger_category_method text,
  ledger_category_score numeric(5,4),
  sync_token text,
  qbo_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS qbo_accounts_connection_qbo_idx ON qbo_accounts (connection_id, qbo_id);
CREATE INDEX IF NOT EXISTS qbo_accounts_ledger_account_idx ON qbo_accounts (ledger_account_id);

-- Vendors. Tax IDs are NEVER stored — only whether one is on file in QuickBooks.
CREATE TABLE IF NOT EXISTS qbo_vendors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  qbo_id text NOT NULL,
  display_name text NOT NULL,
  company_name text,
  vendor_1099 boolean NOT NULL DEFAULT false,
  has_tax_id boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  deleted boolean NOT NULL DEFAULT false,
  balance_cents bigint,
  sync_token text,
  qbo_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS qbo_vendors_connection_qbo_idx ON qbo_vendors (connection_id, qbo_id);

-- Normalized QBO transactions: Purchase, BillPayment, Bill, Deposit, Transfer, VendorCredit.
-- `legs` are the bank/card-side movements ({leg, accountQboId, amountCents} with Ledger's
-- sign convention: negative = money out) used to link to Plaid transactions.
CREATE TABLE IF NOT EXISTS qbo_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  qbo_id text NOT NULL,
  txn_date date NOT NULL,
  total_cents bigint NOT NULL,
  payment_method text,
  doc_number text,
  memo text,
  vendor_qbo_id text,
  payee_name text,
  payee_type text,
  bank_account_qbo_id text,
  bank_account_name text,
  legs jsonb NOT NULL DEFAULT '[]'::jsonb,
  lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  linked_txns jsonb NOT NULL DEFAULT '[]'::jsonb,
  sync_token text,
  deleted boolean NOT NULL DEFAULT false,
  qbo_created_at timestamptz,
  qbo_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS qbo_transactions_connection_entity_idx ON qbo_transactions (connection_id, entity_type, qbo_id);
CREATE INDEX IF NOT EXISTS qbo_transactions_business_date_idx ON qbo_transactions (business_id, txn_date);
CREATE INDEX IF NOT EXISTS qbo_transactions_vendor_idx ON qbo_transactions (connection_id, vendor_qbo_id);

-- QBO transaction leg ↔ Ledger transaction. status 'rejected' remembers a manual unlink so
-- auto-linking never re-creates it.
CREATE TABLE IF NOT EXISTS qbo_transaction_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  qbo_transaction_id uuid NOT NULL REFERENCES qbo_transactions(id) ON DELETE CASCADE,
  leg text NOT NULL DEFAULT 'main',
  transaction_id uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  method text NOT NULL,
  status text NOT NULL DEFAULT 'linked',
  confidence numeric(5,4),
  reasons jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS qbo_transaction_links_pair_idx ON qbo_transaction_links (qbo_transaction_id, leg, transaction_id);
CREATE UNIQUE INDEX IF NOT EXISTS qbo_transaction_links_leg_linked_idx ON qbo_transaction_links (qbo_transaction_id, leg) WHERE status = 'linked';
CREATE UNIQUE INDEX IF NOT EXISTS qbo_transaction_links_txn_linked_idx ON qbo_transaction_links (transaction_id) WHERE status = 'linked';

-- Attachable metadata. Files are downloaded (and imported as receipts) only when attached to a
-- synced transaction.
CREATE TABLE IF NOT EXISTS qbo_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  qbo_id text NOT NULL,
  file_name text,
  content_type text,
  size_bytes bigint,
  note text,
  entity_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  qbo_transaction_id uuid REFERENCES qbo_transactions(id) ON DELETE SET NULL,
  file_sha256 text,
  receipt_id uuid REFERENCES receipts(id) ON DELETE SET NULL,
  import_status text NOT NULL DEFAULT 'pending',
  import_error text,
  deleted boolean NOT NULL DEFAULT false,
  sync_token text,
  qbo_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS qbo_attachments_connection_qbo_idx ON qbo_attachments (connection_id, qbo_id);
CREATE INDEX IF NOT EXISTS qbo_attachments_txn_idx ON qbo_attachments (qbo_transaction_id);
CREATE INDEX IF NOT EXISTS qbo_attachments_receipt_idx ON qbo_attachments (receipt_id);
