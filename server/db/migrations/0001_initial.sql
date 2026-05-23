CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_role AS ENUM ('admin');
CREATE TYPE connection_kind AS ENUM ('bank', 'card', 'gmail');
CREATE TYPE connection_status AS ENUM ('live', 'reauth', 'disconnected');
CREATE TYPE account_kind AS ENUM ('checking', 'savings', 'credit', 'other');
CREATE TYPE receipt_status AS ENUM ('matched', 'pending', 'missing', 'n/a');
CREATE TYPE receipt_source AS ENUM ('upload', 'gmail');
CREATE TYPE receipt_match_status AS ENUM ('suggested', 'accepted', 'rejected', 'auto');
CREATE TYPE alert_kind AS ENUM ('dup', 'missing', 'orphan', 'spike', 'reauth');
CREATE TYPE alert_severity AS ENUM ('warn', 'todo', 'info');
CREATE TYPE alert_status AS ENUM ('open', 'dismissed');
CREATE TYPE job_status AS ENUM ('queued', 'running', 'succeeded', 'failed');
CREATE TYPE export_status AS ENUM ('queued', 'running', 'ready', 'failed');

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  role user_role NOT NULL DEFAULT 'admin',
  totp_secret text,
  totp_enabled boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  short text NOT NULL,
  color text NOT NULL,
  hue integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid REFERENCES businesses(id) ON DELETE SET NULL,
  kind connection_kind NOT NULL,
  label text NOT NULL,
  mask text,
  status connection_status NOT NULL DEFAULT 'live',
  provider_item_id text,
  gmail_email text,
  gmail_history_id text,
  gmail_watch_expiration timestamptz,
  plaid_cursor text,
  encrypted_access_token text,
  encrypted_refresh_token text,
  last_sync_at timestamptz,
  synced_transaction_count integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS connections_kind_idx ON connections(kind);
CREATE INDEX IF NOT EXISTS connections_provider_item_idx ON connections(provider_item_id);

CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  business_id uuid REFERENCES businesses(id) ON DELETE SET NULL,
  plaid_account_id text UNIQUE,
  kind account_kind NOT NULL DEFAULT 'other',
  name text NOT NULL,
  official_name text,
  mask text,
  enabled boolean NOT NULL DEFAULT true,
  current_balance_cents integer,
  available_balance_cents integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS accounts_business_idx ON accounts(business_id);

CREATE TABLE IF NOT EXISTS categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL,
  tax_code text,
  color text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, name)
);

CREATE TABLE IF NOT EXISTS category_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  match_kind text NOT NULL,
  pattern text NOT NULL,
  priority integer NOT NULL DEFAULT 100,
  created_by_ai boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS category_rules_priority_idx ON category_rules(business_id, priority);

CREATE TABLE IF NOT EXISTS receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid REFERENCES businesses(id) ON DELETE SET NULL,
  source receipt_source NOT NULL,
  status receipt_status NOT NULL DEFAULT 'pending',
  merchant text,
  total_cents integer,
  receipt_date date,
  file_key text,
  file_name text,
  mime_type text,
  gmail_message_id text,
  gmail_attachment_id text,
  transaction_id uuid,
  confidence numeric(5,4),
  ocr_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (gmail_message_id, gmail_attachment_id)
);

CREATE INDEX IF NOT EXISTS receipts_business_idx ON receipts(business_id);

CREATE TABLE IF NOT EXISTS transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  plaid_transaction_id text UNIQUE,
  date date NOT NULL,
  authorized_date date,
  merchant text NOT NULL,
  amount_cents integer NOT NULL,
  category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  receipt_id uuid REFERENCES receipts(id) ON DELETE SET NULL,
  receipt_status receipt_status NOT NULL DEFAULT 'missing',
  source_label text NOT NULL,
  note text,
  flag text,
  pending boolean NOT NULL DEFAULT false,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE receipts
  ADD CONSTRAINT receipts_transaction_id_fkey
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS transactions_business_date_idx ON transactions(business_id, date);
CREATE INDEX IF NOT EXISTS transactions_receipt_status_idx ON transactions(receipt_status);

CREATE TABLE IF NOT EXISTS receipt_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  transaction_id uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  score numeric(5,4) NOT NULL,
  status receipt_match_status NOT NULL DEFAULT 'suggested',
  reasons jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);

CREATE INDEX IF NOT EXISTS receipt_matches_receipt_idx ON receipt_matches(receipt_id);

CREATE TABLE IF NOT EXISTS alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
  kind alert_kind NOT NULL,
  severity alert_severity NOT NULL,
  title text NOT NULL,
  detail text NOT NULL,
  status alert_status NOT NULL DEFAULT 'open',
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  dismissed_at timestamptz
);

CREATE INDEX IF NOT EXISTS alerts_status_idx ON alerts(status);

CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs(created_at);

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  status job_status NOT NULL DEFAULT 'queued',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs(status, run_after);

CREATE TABLE IF NOT EXISTS export_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  business_id uuid REFERENCES businesses(id) ON DELETE SET NULL,
  date_from date NOT NULL,
  date_to date NOT NULL,
  status export_status NOT NULL DEFAULT 'queued',
  file_key text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
