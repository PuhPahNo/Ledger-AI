-- Categorization learning-loop fixes. Additive and safe to run on live data.

-- 1. Rule trust is its own flag instead of being inferred from priority (<= 1) and
--    created_by_ai. Backfill with exactly the rules the old inference trusted, so no
--    rule changes trust on deploy.
ALTER TABLE category_rules
  ADD COLUMN IF NOT EXISTS user_confirmed boolean NOT NULL DEFAULT false;

UPDATE category_rules
SET user_confirmed = true
WHERE business_id IS NOT NULL
  AND created_by_ai = false
  AND priority <= 1
  AND user_confirmed = false;

-- 2. Learned merchant rules are upserted per (business, pattern). Concurrent accepts
--    could insert duplicates; collapse them (keeping the rule the engine already applied
--    first: lowest priority, then trusted, then most recent) before adding the unique
--    index the upsert now relies on.
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY business_id, pattern
      ORDER BY priority ASC, user_confirmed DESC, updated_at DESC, id DESC
    ) AS rn
  FROM category_rules
  WHERE match_kind = 'merchant_exact'
    AND business_id IS NOT NULL
)
DELETE FROM category_rules
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS category_rules_business_merchant_exact_idx
  ON category_rules (business_id, pattern)
  WHERE match_kind = 'merchant_exact' AND business_id IS NOT NULL;

-- 3. A user removing a tag from a transaction is remembered, so tag rules re-run on a
--    category change / Plaid update / receipt match don't silently put it back.
--    Manually re-adding the tag clears the suppression.
CREATE TABLE IF NOT EXISTS transaction_tag_suppressions (
  transaction_id uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (transaction_id, tag_id)
);

CREATE INDEX IF NOT EXISTS transaction_tag_suppressions_tag_idx
  ON transaction_tag_suppressions (tag_id);

-- 4. AI suggestions a human accepted from the review center were stored as
--    'ai_suggested', which Plaid updates may overwrite. Promote them to the protected
--    'manual' source (evidence keeps the AI provenance).
UPDATE transactions t
SET category_source = 'manual',
    category_evidence = t.category_evidence || jsonb_build_object('acceptedAiSuggestion', true),
    updated_at = now()
WHERE t.category_source = 'ai_suggested'
  AND t.category_evidence ? 'reviewItemId'
  AND EXISTS (
    SELECT 1
    FROM categorization_review_items r
    WHERE r.id::text = t.category_evidence->>'reviewItemId'
      AND r.type = 'ai_category_suggestion'
      AND r.status = 'accepted'
      AND r.payload->>'proposedCategoryId' = t.category_id::text
  );
