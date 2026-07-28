-- Keep web search available for genuinely ambiguous merchants without exposing the
-- paid tool on every categorization request. Failed/deferred merchant verdicts get a
-- retry window so a nightly scan cannot repeatedly spend on the same bad request.
ALTER TABLE ai_categorization_cache
  ADD COLUMN IF NOT EXISTS outcome text NOT NULL DEFAULT 'result',
  ADD COLUMN IF NOT EXISTS retry_after timestamptz,
  ADD COLUMN IF NOT EXISTS failure_count integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS ai_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workload text NOT NULL,
  model text NOT NULL,
  response_id text,
  status text NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0,
  cached_input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  reasoning_tokens integer NOT NULL DEFAULT 0,
  total_tokens integer NOT NULL DEFAULT 0,
  web_search_calls integer NOT NULL DEFAULT 0,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_usage_events_created_at_idx
  ON ai_usage_events(created_at);

CREATE INDEX IF NOT EXISTS ai_usage_events_workload_created_at_idx
  ON ai_usage_events(workload, created_at);
