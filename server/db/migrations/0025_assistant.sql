-- Single-use ledger for assistant approval tokens (confirm cards, expanded-data approvals).
-- A token's jti is inserted once when it is used; replays hit the primary key and are rejected.
-- Non-destructive: new table only.
CREATE TABLE IF NOT EXISTS assistant_consumed_tokens (
  jti text PRIMARY KEY,
  user_id text NOT NULL,
  kind text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assistant_consumed_tokens_expires_at_idx
  ON assistant_consumed_tokens (expires_at);
