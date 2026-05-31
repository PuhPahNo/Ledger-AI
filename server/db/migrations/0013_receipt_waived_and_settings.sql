-- Add a "waived" receipt status for transactions we intentionally don't expect a receipt for
-- (e.g. spend that predates when receipt collection started). Distinct from 'n/a' (income/fees).
ALTER TYPE receipt_status ADD VALUE IF NOT EXISTS 'waived';

-- Workspace-wide key/value settings (used for receipt_tracking_since cutoff).
CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
