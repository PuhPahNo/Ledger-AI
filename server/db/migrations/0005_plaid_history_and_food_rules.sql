WITH meals AS (
  SELECT id
  FROM categories
  WHERE business_id IS NULL
    AND name = 'Meals'
  ORDER BY created_at, id::text
  LIMIT 1
),
rules(match_kind, pattern, priority) AS (
  VALUES
    ('merchant_contains', 'junction', 2),
    ('merchant_contains', 'starbucks', 2),
    ('merchant_contains', 'dunkin', 2),
    ('merchant_contains', 'sweetgreen', 2),
    ('merchant_contains', 'coffee', 3),
    ('merchant_contains', 'cafe', 3),
    ('merchant_contains', 'restaurant', 3),
    ('merchant_contains', 'doordash', 3),
    ('merchant_contains', 'uber eats', 3),
    ('merchant_contains', 'grubhub', 3),
    ('plaid_category', 'food and drink', 2),
    ('plaid_category', 'restaurant', 2),
    ('plaid_category', 'coffee', 2)
)
UPDATE category_rules
SET category_id = meals.id,
    priority = LEAST(category_rules.priority, rules.priority),
    updated_at = now()
FROM meals, rules
WHERE category_rules.business_id IS NULL
  AND category_rules.match_kind = rules.match_kind
  AND lower(category_rules.pattern) = lower(rules.pattern);

WITH meals AS (
  SELECT id
  FROM categories
  WHERE business_id IS NULL
    AND name = 'Meals'
  ORDER BY created_at, id::text
  LIMIT 1
),
rules(match_kind, pattern, priority) AS (
  VALUES
    ('merchant_contains', 'junction', 2),
    ('merchant_contains', 'starbucks', 2),
    ('merchant_contains', 'dunkin', 2),
    ('merchant_contains', 'sweetgreen', 2),
    ('merchant_contains', 'coffee', 3),
    ('merchant_contains', 'cafe', 3),
    ('merchant_contains', 'restaurant', 3),
    ('merchant_contains', 'doordash', 3),
    ('merchant_contains', 'uber eats', 3),
    ('merchant_contains', 'grubhub', 3),
    ('plaid_category', 'food and drink', 2),
    ('plaid_category', 'restaurant', 2),
    ('plaid_category', 'coffee', 2)
)
INSERT INTO category_rules (category_id, match_kind, pattern, priority)
SELECT meals.id, rules.match_kind, rules.pattern, rules.priority
FROM meals, rules
WHERE NOT EXISTS (
  SELECT 1
  FROM category_rules existing
  WHERE existing.business_id IS NULL
    AND existing.match_kind = rules.match_kind
    AND lower(existing.pattern) = lower(rules.pattern)
);

WITH meals AS (
  SELECT id
  FROM categories
  WHERE business_id IS NULL
    AND name = 'Meals'
  ORDER BY created_at, id::text
  LIMIT 1
)
UPDATE transactions
SET category_id = meals.id,
    updated_at = now()
FROM meals
WHERE transactions.amount_cents < 0
  AND (
    lower(transactions.merchant) LIKE '%junction%'
    OR lower(transactions.merchant) LIKE '%starbucks%'
    OR lower(transactions.merchant) LIKE '%dunkin%'
    OR lower(transactions.merchant) LIKE '%sweetgreen%'
    OR lower(coalesce(transactions.raw -> 'personal_finance_category' ->> 'primary', '')) = 'food_and_drink'
    OR lower(coalesce(transactions.raw -> 'personal_finance_category' ->> 'detailed', '')) LIKE '%restaurant%'
    OR lower(coalesce(transactions.raw -> 'personal_finance_category' ->> 'detailed', '')) LIKE '%coffee%'
  );
