-- Frontend/insights support. Non-destructive: only adds a trigger, an index and
-- copies legacy settings rows; nothing is dropped or rewritten.

-- 1. Keep transactions.updated_at honest. Several code paths (bulk categorize, assistant
--    actions, review accepts) update rows without touching updated_at; month-close
--    sign-off uses it to report "N transactions changed since sign-off". Only bump when the
--    row actually changed and the writer didn't set updated_at itself.
CREATE OR REPLACE FUNCTION ledger_touch_transaction_updated_at() RETURNS trigger AS $$
BEGIN
  IF NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at
     AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'transactions_touch_updated_at'
  ) THEN
    CREATE TRIGGER transactions_touch_updated_at
      BEFORE UPDATE ON transactions
      FOR EACH ROW EXECUTE FUNCTION ledger_touch_transaction_updated_at();
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS transactions_business_date_updated_idx
  ON transactions (business_id, date, updated_at);

-- 2. Alerts are upserted by a stable dedupe key (payload_json.dedupeKey) so a dismissed
--    alert is never regenerated. Legacy rows have no key and are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS alerts_dedupe_key_idx
  ON alerts ((payload_json->>'dedupeKey'))
  WHERE payload_json ? 'dedupeKey';

-- 3. Month-close sign-offs are now keyed close_signoff:<biz>:<YYYY-MM>. Copy legacy
--    close_signoff:<biz>:<from>:<to> rows whose range sits inside one calendar month.
--    Legacy rows are left in place (the app also falls back to reading them).
INSERT INTO app_settings (key, value, updated_at)
SELECT DISTINCT ON (new_key) new_key, value, updated_at
FROM (
  SELECT
    'close_signoff:' || split_part(key, ':', 2) || ':' || substr(split_part(key, ':', 3), 1, 7) AS new_key,
    value,
    updated_at
  FROM app_settings
  WHERE key LIKE 'close_signoff:%:%:%'
    AND split_part(key, ':', 3) ~ '^\d{4}-\d{2}-\d{2}$'
    AND split_part(key, ':', 4) ~ '^\d{4}-\d{2}-\d{2}$'
    AND substr(split_part(key, ':', 3), 1, 7) = substr(split_part(key, ':', 4), 1, 7)
) legacy
ORDER BY new_key, updated_at DESC
ON CONFLICT (key) DO NOTHING;
