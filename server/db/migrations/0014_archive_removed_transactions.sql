-- Preserve removed Plaid transactions instead of silently losing their history.
-- Plaid replaces a pending transaction with a fresh posted row (linked via
-- pending_transaction_id) and then removes the pending row. Sync now carries the
-- user's work (receipt link, notes, protected categories) onto the posted row and
-- archives a snapshot of anything Plaid removes.
CREATE TABLE IF NOT EXISTS archived_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  original_transaction_id uuid NOT NULL,
  plaid_transaction_id text,
  business_id uuid,
  reason text NOT NULL,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS archived_transactions_plaid_idx
  ON archived_transactions (plaid_transaction_id);
