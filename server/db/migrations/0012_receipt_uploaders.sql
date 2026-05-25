CREATE TABLE IF NOT EXISTS receipt_uploaders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid REFERENCES businesses(id) ON DELETE SET NULL,
  username text NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS receipt_uploaders_business_idx
  ON receipt_uploaders(business_id);

CREATE TABLE IF NOT EXISTS receipt_uploader_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  uploader_id uuid NOT NULL REFERENCES receipt_uploaders(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS receipt_uploader_sessions_uploader_idx
  ON receipt_uploader_sessions(uploader_id);

ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS uploaded_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS uploaded_by_uploader_id uuid REFERENCES receipt_uploaders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS file_sha256 text;

CREATE INDEX IF NOT EXISTS receipts_uploaded_by_user_idx
  ON receipts(uploaded_by_user_id);

CREATE INDEX IF NOT EXISTS receipts_uploaded_by_uploader_idx
  ON receipts(uploaded_by_uploader_id);

CREATE INDEX IF NOT EXISTS receipts_file_sha256_idx
  ON receipts(file_sha256);
