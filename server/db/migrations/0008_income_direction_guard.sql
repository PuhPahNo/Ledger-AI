-- Positive app amounts are inflows. Keep them out of Schedule C expense
-- buckets so revenue/deposits cannot inflate spend category reporting.

INSERT INTO categories (business_id, name, tax_code, color)
SELECT NULL, 'Revenue', 'income', '#ffffff'
WHERE NOT EXISTS (
  SELECT 1
  FROM categories
  WHERE business_id IS NULL
    AND (tax_code = 'income' OR lower(name) IN ('income', 'revenue'))
);

INSERT INTO categories (business_id, name, tax_code, color)
SELECT NULL, 'Uncategorized', 'review_required', '#ffffff'
WHERE NOT EXISTS (
  SELECT 1
  FROM categories
  WHERE business_id IS NULL
    AND name = 'Uncategorized'
);

WITH income_categories AS (
  SELECT id, business_id, created_at
  FROM categories
  WHERE active = true
    AND (tax_code = 'income' OR lower(name) IN ('income', 'revenue'))
)
UPDATE transactions
SET category_id = coalesce(
      (
        SELECT income_categories.id
        FROM income_categories
        WHERE income_categories.business_id = transactions.business_id
        ORDER BY income_categories.created_at, income_categories.id::text
        LIMIT 1
      ),
      (
        SELECT income_categories.id
        FROM income_categories
        WHERE income_categories.business_id IS NULL
        ORDER BY income_categories.created_at, income_categories.id::text
        LIMIT 1
      )
    ),
    updated_at = now()
WHERE transactions.amount_cents > 0
  AND EXISTS (SELECT 1 FROM income_categories)
  AND NOT EXISTS (
    SELECT 1
    FROM categories current_category
    WHERE current_category.id = transactions.category_id
      AND (current_category.tax_code = 'income' OR lower(current_category.name) IN ('income', 'revenue'))
  );

WITH income_categories AS (
  SELECT id
  FROM categories
  WHERE tax_code = 'income'
     OR lower(name) IN ('income', 'revenue')
),
uncategorized AS (
  SELECT id
  FROM categories
  WHERE business_id IS NULL
    AND name = 'Uncategorized'
  ORDER BY created_at, id::text
  LIMIT 1
)
UPDATE transactions
SET category_id = uncategorized.id,
    updated_at = now()
FROM uncategorized
WHERE transactions.amount_cents < 0
  AND transactions.category_id IN (SELECT id FROM income_categories);
