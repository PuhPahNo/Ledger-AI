UPDATE transactions
SET business_id = accounts.business_id,
    updated_at = now()
FROM accounts
WHERE transactions.account_id = accounts.id
  AND accounts.business_id IS NOT NULL
  AND transactions.business_id <> accounts.business_id;
