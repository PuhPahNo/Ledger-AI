-- Categorization automation: auto-learned merchant rules with an exact undo log, and
-- external category signals (e.g. QuickBooks account mappings). Additive only: widens
-- two CHECK constraints to supersets and adds new tables/indexes. No existing row changes.

-- 1. New category source for signals coming from outside systems (QuickBooks etc.).
--    Machine-level trust: not protected, so rules/humans still win.
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_category_source_check;
ALTER TABLE transactions
  ADD CONSTRAINT transactions_category_source_check
  CHECK (category_source IN (
    'manual',
    'user_confirmed_rule',
    'auto_rule',
    'plaid_signal',
    'ai_suggested',
    'receipt_evidence',
    'external_signal',
    'uncategorized'
  ));

-- 2. Low-confidence (or protected-row) external signals become a review item.
ALTER TABLE categorization_review_items DROP CONSTRAINT IF EXISTS categorization_review_items_type_check;
ALTER TABLE categorization_review_items
  ADD CONSTRAINT categorization_review_items_type_check
  CHECK (type IN (
    'learn_rule_prompt',
    'ai_category_suggestion',
    'receipt_category_override',
    'rule_conflict_review',
    'external_category_suggestion'
  ));

-- 3. Every time the system learns (or a person confirms) a merchant rule: who, when,
--    which corrections, and the rule's prior state so undo can put it back.
CREATE TABLE IF NOT EXISTS categorization_learned_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  rule_id uuid REFERENCES category_rules(id) ON DELETE SET NULL,
  merchant text NOT NULL,
  normalized_merchant text NOT NULL,
  category_id uuid NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  learned_via text NOT NULL CHECK (learned_via IN (
    'consistent_corrections',
    'learn_prompt_accepted',
    'review_group_accepted',
    'rule_conflict_accepted'
  )),
  -- NULL: the rule did not exist before this event (undo deletes it).
  previous_rule jsonb,
  feedback_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  source_transaction_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  applied_count integer NOT NULL DEFAULT 0,
  skipped_protected_count integer NOT NULL DEFAULT 0,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz,
  undone_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  undo_restored_count integer,
  undo_skipped_count integer
);

CREATE INDEX IF NOT EXISTS categorization_learned_rules_merchant_idx
  ON categorization_learned_rules (business_id, normalized_merchant, created_at DESC);
CREATE INDEX IF NOT EXISTS categorization_learned_rules_created_idx
  ON categorization_learned_rules (created_at DESC);

-- 4. Each transaction a learned rule relabelled, with its exact prior categorization.
CREATE TABLE IF NOT EXISTS categorization_rule_relabels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  learned_rule_id uuid NOT NULL REFERENCES categorization_learned_rules(id) ON DELETE CASCADE,
  transaction_id uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  previous_category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  previous_category_source text NOT NULL,
  previous_category_confidence numeric(5,4),
  previous_category_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  new_category_id uuid NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  restored_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS categorization_rule_relabels_event_txn_idx
  ON categorization_rule_relabels (learned_rule_id, transaction_id);
CREATE INDEX IF NOT EXISTS categorization_rule_relabels_txn_idx
  ON categorization_rule_relabels (transaction_id);

-- 5. "Handled automatically" stats scan recent category events by time.
CREATE INDEX IF NOT EXISTS transaction_category_events_created_idx
  ON transaction_category_events (created_at);
