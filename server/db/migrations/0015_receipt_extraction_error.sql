-- Surface receipt extraction failures instead of leaving receipts silently stuck.
-- A pending receipt with no total/date can never match, and nothing told the user why.
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS extraction_error text;
