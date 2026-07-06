-- Insights aggregates join on category_id and receipt lookups filter on receipt_id;
-- both were unindexed full scans.
CREATE INDEX IF NOT EXISTS transactions_category_idx ON transactions (category_id);
CREATE INDEX IF NOT EXISTS transactions_receipt_idx ON transactions (receipt_id);
