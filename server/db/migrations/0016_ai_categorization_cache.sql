-- Cache AI categorization verdicts per merchant. Every rule-less transaction previously
-- triggered a fresh OpenAI call (with web search) even for a merchant judged minutes
-- earlier — unbounded spend for zero new information. Null category_id caches "nothing
-- fits" so hopeless merchants stop re-asking too.
CREATE TABLE IF NOT EXISTS ai_categorization_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  normalized_merchant text NOT NULL,
  direction text NOT NULL DEFAULT 'out',
  category_id uuid REFERENCES categories(id) ON DELETE CASCADE,
  confidence numeric(5,4),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, normalized_merchant, direction)
);
