-- Receipt workflow: "no receipt needed" rules + per-transaction waiver evidence, and indexes for
-- the recently-matched list and match queue. Non-destructive: new tables/indexes only, plus one
-- seeded (disabled) global threshold rule.

CREATE TABLE IF NOT EXISTS receipt_waiver_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('threshold', 'merchant', 'category')),
  enabled boolean NOT NULL DEFAULT true,
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
  threshold_cents integer CHECK (threshold_cents IS NULL OR threshold_cents > 0),
  exclude_lodging boolean NOT NULL DEFAULT true,
  merchant_pattern text,
  merchant_label text,
  category_id uuid REFERENCES categories(id) ON DELETE CASCADE,
  note text,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'threshold' OR threshold_cents IS NOT NULL),
  CHECK (kind <> 'merchant' OR (merchant_pattern IS NOT NULL AND length(merchant_pattern) >= 2)),
  CHECK (kind <> 'category' OR category_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS receipt_waiver_rules_kind_idx ON receipt_waiver_rules (kind);

-- Exactly one global threshold rule.
CREATE UNIQUE INDEX IF NOT EXISTS receipt_waiver_rules_threshold_unique_idx
  ON receipt_waiver_rules (kind) WHERE kind = 'threshold';

-- One merchant rule per (pattern, business scope).
CREATE UNIQUE INDEX IF NOT EXISTS receipt_waiver_rules_merchant_unique_idx
  ON receipt_waiver_rules (merchant_pattern, coalesce(business_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE kind = 'merchant';

-- One category rule per category.
CREATE UNIQUE INDEX IF NOT EXISTS receipt_waiver_rules_category_unique_idx
  ON receipt_waiver_rules (category_id) WHERE kind = 'category';

-- Off until the owner enables it: IRS generally doesn't require receipts under $75 (except lodging).
INSERT INTO receipt_waiver_rules (kind, enabled, threshold_cents, exclude_lodging, note)
SELECT 'threshold', false, 7500, true, 'IRS: receipts generally not required for expenses under $75 (lodging excepted)'
WHERE NOT EXISTS (SELECT 1 FROM receipt_waiver_rules WHERE kind = 'threshold');

CREATE TABLE IF NOT EXISTS transaction_receipt_waivers (
  transaction_id uuid PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
  rule_id uuid REFERENCES receipt_waiver_rules(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('threshold', 'merchant', 'category', 'manual')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transaction_receipt_waivers_rule_idx ON transaction_receipt_waivers (rule_id);

-- Recently matched list: live auto/manual pairs by decision time.
CREATE INDEX IF NOT EXISTS receipt_matches_decided_idx
  ON receipt_matches (decided_at DESC)
  WHERE status IN ('auto', 'accepted');

-- Match queue: unmatched pending receipts.
CREATE INDEX IF NOT EXISTS receipts_unmatched_queue_idx
  ON receipts (created_at DESC)
  WHERE status = 'pending' AND transaction_id IS NULL;
