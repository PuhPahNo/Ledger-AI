-- Add deterministic Plaid/tax mappings so common business expenses do not
-- fall through to AI or stay in Uncategorized.

INSERT INTO categories (business_id, name, tax_code, color)
SELECT NULL, 'Transfers', 'exclude_transfer', '#ffffff'
WHERE NOT EXISTS (
  SELECT 1
  FROM categories
  WHERE business_id IS NULL
    AND name = 'Transfers'
);

WITH rules(category_name, match_kind, pattern, priority) AS (
  VALUES
    ('Transfers', 'plaid_category', 'transfer out', 1),
    ('Transfers', 'plaid_category', 'account transfer', 1),
    ('Transfers', 'plaid_category', 'credit card payment', 1),
    ('Transfers', 'plaid_category', 'loan payments credit card', 1),
    ('Advertising & Marketing', 'plaid_category', 'advertising', 5),
    ('Advertising & Marketing', 'plaid_category', 'marketing', 5),
    ('Cloud', 'merchant_contains', 'aws', 5),
    ('Cloud', 'merchant_contains', 'google cloud', 5),
    ('Cloud', 'merchant_contains', 'cloudflare', 5),
    ('Software', 'plaid_category', 'software', 5),
    ('Software', 'merchant_contains', 'github', 5),
    ('Software', 'merchant_contains', 'slack', 5),
    ('Software', 'merchant_contains', 'zoom', 5),
    ('Meals', 'plaid_category', 'food and drink', 2),
    ('Meals', 'plaid_category', 'restaurant', 2),
    ('Travel', 'plaid_category', 'travel', 5),
    ('Travel', 'plaid_category', 'airline', 5),
    ('Travel', 'plaid_category', 'hotel', 5),
    ('Car & Truck', 'plaid_category', 'gas station', 5),
    ('Car & Truck', 'plaid_category', 'parking', 5),
    ('Office Expense', 'plaid_category', 'office supplies', 5),
    ('Office Expense', 'plaid_category', 'shipping', 5),
    ('Inventory', 'plaid_category', 'wholesale', 5),
    ('Inventory', 'merchant_contains', 'costco business', 5),
    ('Equipment', 'plaid_category', 'electronics', 5),
    ('Equipment', 'merchant_contains', 'apple store', 5),
    ('Utilities', 'plaid_category', 'utilities', 5),
    ('Utilities', 'plaid_category', 'telecommunications', 5),
    ('Utilities', 'merchant_contains', 'comcast', 5),
    ('Insurance', 'plaid_category', 'insurance', 5),
    ('Taxes & Licenses', 'plaid_category', 'tax', 5),
    ('Taxes & Licenses', 'plaid_category', 'license', 5),
    ('Wages', 'plaid_category', 'payroll', 5),
    ('Contract Labor', 'merchant_contains', 'upwork', 5),
    ('Contract Labor', 'merchant_contains', 'fiverr', 5),
    ('Legal & Professional', 'plaid_category', 'legal', 5),
    ('Legal & Professional', 'plaid_category', 'accounting', 5),
    ('Repairs & Maintenance', 'plaid_category', 'repair', 5),
    ('Interest', 'plaid_category', 'interest', 5),
    ('Commissions & Fees', 'plaid_category', 'bank fee', 5),
    ('Commissions & Fees', 'plaid_category', 'processing fee', 5),
    ('Entertainment', 'plaid_category', 'entertainment', 5),
    ('Supplies', 'plaid_category', 'general merchandise', 20)
)
INSERT INTO category_rules (category_id, match_kind, pattern, priority)
SELECT category.id, rules.match_kind, rules.pattern, rules.priority
FROM rules
INNER JOIN categories category
  ON category.business_id IS NULL
 AND category.name = rules.category_name
WHERE NOT EXISTS (
  SELECT 1
  FROM category_rules existing
  WHERE existing.business_id IS NULL
    AND existing.category_id = category.id
    AND existing.match_kind = rules.match_kind
    AND lower(existing.pattern) = lower(rules.pattern)
);

WITH signals AS (
  SELECT
    transactions.id,
    lower(concat_ws(' ',
      transactions.merchant,
      transactions.raw ->> 'name',
      transactions.raw ->> 'merchant_name',
      transactions.raw -> 'category',
      transactions.raw -> 'personal_finance_category' ->> 'primary',
      transactions.raw -> 'personal_finance_category' ->> 'detailed'
    )) AS signal
  FROM transactions
  LEFT JOIN categories current_category ON transactions.category_id = current_category.id
  WHERE transactions.amount_cents < 0
    AND (transactions.category_id IS NULL OR current_category.name = 'Uncategorized')
),
mapped AS (
  SELECT
    id,
    CASE
      WHEN signal ~ 'transfer.out|account.transfer|credit.card.payment|loan.payments.credit.card|investment.and.retirement|savings.transfer' THEN 'Transfers'
      WHEN signal ~ 'advertising|marketing|google ads|facebook ads|meta ads|linkedin ads|mailchimp|klaviyo' THEN 'Advertising & Marketing'
      WHEN signal ~ 'aws|amazon web services|google cloud|gcp|azure|cloudflare|digital ocean|heroku|render|vercel|netlify|supabase' THEN 'Cloud'
      WHEN signal ~ 'software|figma|notion|adobe|linear|github|slack|zoom|google workspace|microsoft|openai|anthropic|canva|airtable|quickbooks|xero' THEN 'Software'
      WHEN signal ~ 'food.and.drink|restaurant|coffee|cafe|fast.food|sweetgreen|starbucks|doordash|uber eats|grubhub' THEN 'Meals'
      WHEN signal ~ 'airline|airport|hotel|lodging|travel|taxi|rideshare|lyft|rental car|airbnb' THEN 'Travel'
      WHEN signal ~ 'gas.station|fuel|parking|toll|automotive|auto.parts|vehicle|car wash' THEN 'Car & Truck'
      WHEN signal ~ 'office.supplies|printing|postage|shipping|usps|fedex|ups store' THEN 'Office Expense'
      WHEN signal ~ 'wholesale|inventory|cost.of.goods|supplier|product|merchandise|costco business' THEN 'Inventory'
      WHEN signal ~ 'electronics|hardware|equipment|computer.equipment|apple store|best buy|square hardware' THEN 'Equipment'
      WHEN signal ~ 'utilities|internet|telecom|mobile.phone|comcast|verizon|at.t|t.mobile|electric|water|natural.gas' THEN 'Utilities'
      WHEN signal ~ 'rent|lease|property.management' THEN 'Rent Or Lease'
      WHEN signal ~ 'insurance' THEN 'Insurance'
      WHEN signal ~ 'tax.payment|taxes|license|permit|irs|department.of.revenue|secretary.of.state' THEN 'Taxes & Licenses'
      WHEN signal ~ 'payroll|wages|salary|gusto|adp|paychex' THEN 'Wages'
      WHEN signal ~ 'contractor|freelance|upwork|fiverr' THEN 'Contract Labor'
      WHEN signal ~ 'legal|attorney|lawyer|accounting|accountant|bookkeeping|professional.services|consulting|tax.prep' THEN 'Legal & Professional'
      WHEN signal ~ 'repair|maintenance' THEN 'Repairs & Maintenance'
      WHEN signal ~ 'interest.charge|loan.interest' THEN 'Interest'
      WHEN signal ~ 'bank.fee|atm.fee|processing.fee|service.fee|merchant.fee|commission|stripe.fee|paypal.fee|square.fee' THEN 'Commissions & Fees'
      WHEN signal ~ 'entertainment|amusement|event.tickets|movies|sports.venue' THEN 'Entertainment'
      WHEN signal ~ 'general.merchandise|amazon|target|walmart|office depot|staples' THEN 'Supplies'
      ELSE NULL
    END AS category_name
  FROM signals
)
UPDATE transactions
SET category_id = category.id,
    updated_at = now()
FROM mapped
INNER JOIN categories category
  ON category.business_id IS NULL
 AND category.name = mapped.category_name
WHERE transactions.id = mapped.id
  AND mapped.category_name IS NOT NULL;

UPDATE transactions
SET receipt_status = 'n/a',
    updated_at = now()
FROM categories
WHERE transactions.category_id = categories.id
  AND categories.tax_code LIKE 'exclude_%'
  AND transactions.receipt_status = 'missing';
