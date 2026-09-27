-- Receipt ↔ transaction pairing integrity, user-edit protection, and fair rematch ordering.
-- Non-destructive: only repairs dangling/duplicate links (deterministically) before adding
-- the uniqueness guard. Safe to re-run.

-- Fields the user corrected by hand (merchant / totalCents / receiptDate). A late extraction
-- retry must never overwrite them.
ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS user_edited_fields text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS last_match_attempt_at timestamptz;

-- 1. A receipt held by more than one transaction: keep the transaction the receipt itself
--    points at, else the most recently updated one (id as a stable tie-break). Release the rest
--    back to the status they would have had without a receipt.
WITH ranked AS (
  SELECT
    t.id,
    row_number() OVER (
      PARTITION BY t.receipt_id
      ORDER BY (t.id = r.transaction_id) DESC NULLS LAST, t.updated_at DESC, t.id
    ) AS rn
  FROM transactions t
  LEFT JOIN receipts r ON r.id = t.receipt_id
  WHERE t.receipt_id IS NOT NULL
),
tracking AS (
  SELECT (SELECT value FROM app_settings WHERE key = 'receipt_tracking_since') AS since
)
UPDATE transactions t
SET
  receipt_id = NULL,
  receipt_status = CASE
    WHEN t.receipt_status <> 'matched' THEN t.receipt_status
    WHEN t.amount_cents >= 0 THEN 'n/a'::receipt_status
    WHEN tracking.since IS NOT NULL AND t.date < tracking.since::date THEN 'waived'::receipt_status
    ELSE 'missing'::receipt_status
  END,
  updated_at = now()
FROM ranked, tracking
WHERE ranked.id = t.id AND ranked.rn > 1;

-- 2. Make the receipt side agree with the (now unique) transaction side.
UPDATE receipts r
SET transaction_id = t.id, status = 'matched', updated_at = now()
FROM transactions t
WHERE t.receipt_id = r.id
  AND (r.transaction_id IS DISTINCT FROM t.id OR r.status <> 'matched');

-- 3. Receipts pointing at a transaction that no longer holds them go back to the review queue.
UPDATE receipts r
SET
  transaction_id = NULL,
  status = CASE WHEN r.status = 'matched' THEN 'pending'::receipt_status ELSE r.status END,
  updated_at = now()
WHERE r.transaction_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.receipt_id = r.id);

-- 4. DB guard: one transaction per receipt.
CREATE UNIQUE INDEX IF NOT EXISTS transactions_receipt_id_unique_idx
  ON transactions (receipt_id)
  WHERE receipt_id IS NOT NULL;

-- Rematch sweep takes the least-recently-tried unmatched receipts first.
CREATE INDEX IF NOT EXISTS receipts_rematch_queue_idx
  ON receipts (last_match_attempt_at ASC NULLS FIRST, created_at DESC)
  WHERE transaction_id IS NULL AND status = 'pending';

-- Gmail re-backfills dedupe attachments by content within a message.
CREATE INDEX IF NOT EXISTS receipts_gmail_message_sha_idx
  ON receipts (gmail_message_id, file_sha256)
  WHERE gmail_message_id IS NOT NULL;
