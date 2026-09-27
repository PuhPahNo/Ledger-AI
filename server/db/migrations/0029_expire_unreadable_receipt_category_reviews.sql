-- Receipts read by the regex fallback (confidence < 0.5) carry no category evidence, but their
-- system note was keyword-matched into bogus suggestions (e.g. "CPA invoice -> Software").
-- Expire any such open review items; the code no longer creates them.
UPDATE categorization_review_items
SET status = 'expired',
    resolved_action = 'receipt_unreadable',
    resolved_at = now(),
    updated_at = now()
WHERE status = 'open'
  AND type = 'receipt_category_override'
  AND payload->'evidence' ? 'receiptConfidence'
  AND (payload->'evidence'->>'receiptConfidence') ~ '^[0-9.]+$'
  AND (payload->'evidence'->>'receiptConfidence')::numeric < 0.5;
