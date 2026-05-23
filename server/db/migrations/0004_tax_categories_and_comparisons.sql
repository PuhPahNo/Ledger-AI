WITH ranked AS (
  SELECT
    id,
    first_value(id) OVER (PARTITION BY name ORDER BY created_at, id::text) AS keep_id,
    row_number() OVER (PARTITION BY name ORDER BY created_at, id::text) AS rn
  FROM categories
  WHERE business_id IS NULL
)
UPDATE transactions
SET category_id = ranked.keep_id,
    updated_at = now()
FROM ranked
WHERE transactions.category_id = ranked.id
  AND ranked.rn > 1;

WITH ranked AS (
  SELECT
    id,
    first_value(id) OVER (PARTITION BY name ORDER BY created_at, id::text) AS keep_id,
    row_number() OVER (PARTITION BY name ORDER BY created_at, id::text) AS rn
  FROM categories
  WHERE business_id IS NULL
)
UPDATE category_rules
SET category_id = ranked.keep_id,
    updated_at = now()
FROM ranked
WHERE category_rules.category_id = ranked.id
  AND ranked.rn > 1;

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (PARTITION BY name ORDER BY created_at, id::text) AS rn
  FROM categories
  WHERE business_id IS NULL
)
DELETE FROM categories
USING ranked
WHERE categories.id = ranked.id
  AND ranked.rn > 1;

UPDATE categories
SET tax_code = v.tax_code,
    color = coalesce(categories.color, v.color),
    updated_at = now()
FROM (VALUES
  ('Software', 'other_expense_software', '#ff8b6b'),
  ('Cloud', 'other_expense_software', '#9fc6e8'),
  ('Travel', 'schedule_c_line_24a', '#3e2a3e'),
  ('Inventory', 'cogs_inventory', '#abc89a'),
  ('Meals', 'schedule_c_line_24b', '#f1b6c5'),
  ('Supplies', 'schedule_c_line_22', '#caa6f0'),
  ('Utilities', 'schedule_c_line_25', '#9fc6e8'),
  ('Equipment', 'schedule_c_line_13_review', '#ecd95a'),
  ('Revenue', 'income', '#ffffff')
) AS v(name, tax_code, color)
WHERE categories.business_id IS NULL
  AND categories.name = v.name;

INSERT INTO categories (business_id, name, tax_code, color)
SELECT NULL, v.name, v.tax_code, v.color
FROM (VALUES
  ('Advertising & Marketing', 'schedule_c_line_8', '#ff8b6b'),
  ('Car & Truck', 'schedule_c_line_9', '#9fc6e8'),
  ('Commissions & Fees', 'schedule_c_line_10', '#caa6f0'),
  ('Contract Labor', 'schedule_c_line_11', '#abc89a'),
  ('Depreciation & Section 179', 'schedule_c_line_13', '#ecd95a'),
  ('Employee Benefits', 'schedule_c_line_14', '#f1b6c5'),
  ('Insurance', 'schedule_c_line_15', '#9fc6e8'),
  ('Interest', 'schedule_c_line_16', '#3e2a3e'),
  ('Legal & Professional', 'schedule_c_line_17', '#ff8b6b'),
  ('Office Expense', 'schedule_c_line_18', '#f7f3e6'),
  ('Rent Or Lease', 'schedule_c_line_20', '#abc89a'),
  ('Repairs & Maintenance', 'schedule_c_line_21', '#caa6f0'),
  ('Taxes & Licenses', 'schedule_c_line_23', '#ecd95a'),
  ('Wages', 'schedule_c_line_26', '#9fc6e8'),
  ('Entertainment', 'non_deductible_review', '#3e2a3e'),
  ('Uncategorized', 'review_required', '#ffffff')
) AS v(name, tax_code, color)
WHERE NOT EXISTS (
  SELECT 1
  FROM categories c
  WHERE c.business_id IS NULL
    AND c.name = v.name
);
