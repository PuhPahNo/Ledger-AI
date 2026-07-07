-- Custom tags: a global labeling layer on top of per-business categories, so
-- cross-business spend themes (e.g. "AI" across all three businesses) can be tracked
-- in one place. Rules auto-apply tags by merchant match during sync; manual
-- assignments are never removed by the rules engine.
CREATE TABLE IF NOT EXISTS tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  color text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- "AI" and "ai" are the same tag.
CREATE UNIQUE INDEX IF NOT EXISTS tags_name_lower_idx ON tags (lower(name));

CREATE TABLE IF NOT EXISTS transaction_tags (
  transaction_id uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  -- 'manual' (user-applied) or 'auto' (rule-applied). Manual wins: auto passes never
  -- downgrade or remove it.
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (transaction_id, tag_id)
);

CREATE INDEX IF NOT EXISTS transaction_tags_tag_idx ON transaction_tags (tag_id);

CREATE TABLE IF NOT EXISTS tag_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  -- 'merchant_exact' | 'merchant_contains', matched against the normalized merchant.
  match_kind text NOT NULL,
  pattern text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tag_rules_tag_idx ON tag_rules (tag_id);
CREATE UNIQUE INDEX IF NOT EXISTS tag_rules_dedupe_idx ON tag_rules (tag_id, match_kind, pattern);
