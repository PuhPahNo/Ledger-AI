DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM businesses WHERE key = 'aurora')
     AND NOT EXISTS (SELECT 1 FROM businesses WHERE key = 'draft-sharks') THEN
    UPDATE businesses
    SET key = 'draft-sharks',
        name = 'Draft Sharks',
        short = 'DS',
        color = '#D97757',
        hue = 24,
        active = true,
        updated_at = now()
    WHERE key = 'aurora';
  END IF;

  IF EXISTS (SELECT 1 FROM businesses WHERE key = 'meridian')
     AND NOT EXISTS (SELECT 1 FROM businesses WHERE key = 'pointsnav') THEN
    UPDATE businesses
    SET key = 'pointsnav',
        name = 'PointsNav',
        short = 'PN',
        color = '#2A6FDB',
        hue = 230,
        active = true,
        updated_at = now()
    WHERE key = 'meridian';
  END IF;

  IF EXISTS (SELECT 1 FROM businesses WHERE key = 'kiln')
     AND NOT EXISTS (SELECT 1 FROM businesses WHERE key = 'womens-net') THEN
    UPDATE businesses
    SET key = 'womens-net',
        name = 'Womens Net',
        short = 'WN',
        color = '#1F8A5B',
        hue = 155,
        active = true,
        updated_at = now()
    WHERE key = 'kiln';
  END IF;
END $$;

INSERT INTO businesses (key, name, short, color, hue, active)
VALUES
  ('draft-sharks', 'Draft Sharks', 'DS', '#D97757', 24, true),
  ('pointsnav', 'PointsNav', 'PN', '#2A6FDB', 230, true),
  ('womens-net', 'Womens Net', 'WN', '#1F8A5B', 155, true)
ON CONFLICT (key) DO UPDATE SET
  name = EXCLUDED.name,
  short = EXCLUDED.short,
  color = EXCLUDED.color,
  hue = EXCLUDED.hue,
  active = EXCLUDED.active,
  updated_at = now();

DELETE FROM transactions
WHERE plaid_transaction_id IS NULL
  AND merchant IN (
    'Figma',
    'AWS',
    'Sweetgreen',
    'Whole Bean Roasters',
    'Notion',
    'Notion (annual)'
  );

DELETE FROM connections
WHERE provider_item_id IS NULL
  AND encrypted_access_token IS NULL
  AND gmail_email IS NULL
  AND label = 'Chase Business';
