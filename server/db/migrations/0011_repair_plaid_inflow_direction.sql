-- Repair Plaid rows whose stored app direction contradicts Plaid's own
-- income / transfer-in signal. These rows were inflating spend charts because
-- they were negative app amounts and often landed in expense categories.

INSERT INTO categories (business_id, name, tax_code, color)
SELECT NULL, 'Revenue', 'income', '#ffffff'
WHERE NOT EXISTS (
  SELECT 1
  FROM categories
  WHERE business_id IS NULL
    AND (tax_code = 'income' OR lower(name) IN ('income', 'revenue'))
);

INSERT INTO categories (business_id, name, tax_code, color)
SELECT NULL, 'Transfers', 'exclude_transfer', '#ffffff'
WHERE NOT EXISTS (
  SELECT 1
  FROM categories
  WHERE business_id IS NULL
    AND name = 'Transfers'
);

WITH plaid_direction AS (
  SELECT
    transactions.id,
    upper(coalesce(transactions.raw -> 'personal_finance_category' ->> 'primary', '')) AS plaid_primary,
    upper(coalesce(transactions.raw -> 'personal_finance_category' ->> 'detailed', '')) AS plaid_detailed,
    revenue.id AS revenue_category_id,
    transfers.id AS transfers_category_id
  FROM transactions
  LEFT JOIN LATERAL (
    SELECT id
    FROM categories
    WHERE business_id IS NULL
      AND (tax_code = 'income' OR lower(name) IN ('income', 'revenue'))
    ORDER BY created_at, id::text
    LIMIT 1
  ) revenue ON true
  LEFT JOIN LATERAL (
    SELECT id
    FROM categories
    WHERE business_id IS NULL
      AND name = 'Transfers'
    ORDER BY created_at, id::text
    LIMIT 1
  ) transfers ON true
  WHERE transactions.plaid_transaction_id IS NOT NULL
    AND (
      upper(coalesce(transactions.raw -> 'personal_finance_category' ->> 'primary', '')) LIKE 'INCOME%'
      OR upper(coalesce(transactions.raw -> 'personal_finance_category' ->> 'detailed', '')) LIKE 'INCOME%'
      OR upper(coalesce(transactions.raw -> 'personal_finance_category' ->> 'primary', '')) = 'TRANSFER_IN'
      OR upper(coalesce(transactions.raw -> 'personal_finance_category' ->> 'detailed', '')) LIKE 'TRANSFER_IN%'
    )
)
UPDATE transactions
SET amount_cents = abs(transactions.amount_cents),
    category_id = CASE
      WHEN transactions.category_source IN ('manual', 'user_confirmed_rule', 'receipt_evidence') THEN transactions.category_id
      WHEN plaid_direction.plaid_primary = 'TRANSFER_IN'
        OR plaid_direction.plaid_detailed LIKE 'TRANSFER_IN%'
        THEN plaid_direction.transfers_category_id
      ELSE plaid_direction.revenue_category_id
    END,
    category_source = CASE
      WHEN transactions.category_source IN ('manual', 'user_confirmed_rule', 'receipt_evidence') THEN transactions.category_source
      WHEN plaid_direction.plaid_primary = 'TRANSFER_IN'
        OR plaid_direction.plaid_detailed LIKE 'TRANSFER_IN%'
        THEN 'plaid_signal'
      ELSE 'auto_rule'
    END,
    category_confidence = CASE
      WHEN transactions.category_source IN ('manual', 'user_confirmed_rule', 'receipt_evidence') THEN transactions.category_confidence
      ELSE 1.0000
    END,
    category_evidence = CASE
      WHEN transactions.category_source IN ('manual', 'user_confirmed_rule', 'receipt_evidence')
        THEN transactions.category_evidence || jsonb_build_object(
          'directionRepair', '0011_repair_plaid_inflow_direction',
          'plaidPrimary', plaid_direction.plaid_primary,
          'plaidDetailed', plaid_direction.plaid_detailed,
          'previousAmountCents', transactions.amount_cents
        )
      ELSE jsonb_build_object(
        'migration', '0011_repair_plaid_inflow_direction',
        'plaidPrimary', plaid_direction.plaid_primary,
        'plaidDetailed', plaid_direction.plaid_detailed,
        'previousAmountCents', transactions.amount_cents
      )
    END,
    receipt_status = 'n/a',
    updated_at = now()
FROM plaid_direction
WHERE transactions.id = plaid_direction.id
  AND transactions.amount_cents < 0;
