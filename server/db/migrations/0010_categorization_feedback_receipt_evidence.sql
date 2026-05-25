-- Track categorization provenance, asynchronous review prompts, and receipt
-- evidence so the system can learn without silently overwriting user intent.

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS category_source text NOT NULL DEFAULT 'uncategorized',
  ADD COLUMN IF NOT EXISTS category_confidence numeric(5,4),
  ADD COLUMN IF NOT EXISTS category_evidence jsonb NOT NULL DEFAULT '{}'::jsonb;

WITH uncategorized AS (
  SELECT id
  FROM categories
  WHERE name = 'Uncategorized'
)
UPDATE transactions
SET category_source = CASE
      WHEN transactions.category_id IS NULL THEN 'uncategorized'
      WHEN transactions.category_id IN (SELECT id FROM uncategorized) THEN 'uncategorized'
      ELSE 'auto_rule'
    END,
    category_confidence = CASE
      WHEN transactions.category_id IS NULL THEN NULL
      ELSE coalesce(transactions.category_confidence, 0.7500)
    END,
    category_evidence = CASE
      WHEN transactions.category_evidence = '{}'::jsonb THEN jsonb_build_object('migration', '0010_categorization_feedback_receipt_evidence')
      ELSE transactions.category_evidence
    END
WHERE transactions.category_source = 'uncategorized'
   OR transactions.category_confidence IS NULL
   OR transactions.category_evidence = '{}'::jsonb;

CREATE TABLE IF NOT EXISTS categorization_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  transaction_id uuid REFERENCES transactions(id) ON DELETE SET NULL,
  merchant text NOT NULL,
  normalized_merchant text NOT NULL,
  previous_category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  new_category_id uuid NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  source text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS categorization_feedback_merchant_idx
  ON categorization_feedback(business_id, normalized_merchant);

CREATE TABLE IF NOT EXISTS categorization_review_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  type text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  fingerprint text NOT NULL,
  title text NOT NULL,
  detail text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved_action text,
  resolved_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS categorization_review_items_status_idx
  ON categorization_review_items(status, created_at);

CREATE INDEX IF NOT EXISTS categorization_review_items_business_status_idx
  ON categorization_review_items(business_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS categorization_review_items_dedupe_idx
  ON categorization_review_items(business_id, type, fingerprint)
  WHERE status = 'open';

CREATE TABLE IF NOT EXISTS transaction_category_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  transaction_id uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  previous_category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  new_category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  source text NOT NULL,
  confidence numeric(5,4),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transaction_category_events_transaction_idx
  ON transaction_category_events(transaction_id, created_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'transactions_category_source_check'
  ) THEN
    ALTER TABLE transactions
      ADD CONSTRAINT transactions_category_source_check
      CHECK (category_source IN (
        'manual',
        'user_confirmed_rule',
        'auto_rule',
        'plaid_signal',
        'ai_suggested',
        'receipt_evidence',
        'uncategorized'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'categorization_review_items_type_check'
  ) THEN
    ALTER TABLE categorization_review_items
      ADD CONSTRAINT categorization_review_items_type_check
      CHECK (type IN (
        'learn_rule_prompt',
        'ai_category_suggestion',
        'receipt_category_override',
        'rule_conflict_review'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'categorization_review_items_status_check'
  ) THEN
    ALTER TABLE categorization_review_items
      ADD CONSTRAINT categorization_review_items_status_check
      CHECK (status IN ('open', 'accepted', 'dismissed', 'expired'));
  END IF;
END $$;
