-- Account & connection nicknames: let users override the Plaid-supplied label
-- without it being overwritten on the next sync.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS nickname text;

ALTER TABLE connections
  ADD COLUMN IF NOT EXISTS label_user_set boolean NOT NULL DEFAULT false;
