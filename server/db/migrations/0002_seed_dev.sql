INSERT INTO businesses (key, name, short, color, hue)
VALUES
  ('aurora', 'Aurora Studio', 'AS', '#D97757', 24),
  ('meridian', 'Meridian Holdings', 'MH', '#2A6FDB', 230),
  ('kiln', 'Kiln Coffee Co.', 'KC', '#1F8A5B', 155)
ON CONFLICT (key) DO NOTHING;

INSERT INTO categories (business_id, name, tax_code, color)
SELECT NULL, name, tax_code, color
FROM (VALUES
  ('Software', 'software', '#ff8b6b'),
  ('Cloud', 'cloud', '#9fc6e8'),
  ('Travel', 'travel', '#3e2a3e'),
  ('Inventory', 'inventory', '#abc89a'),
  ('Meals', 'meals', '#f1b6c5'),
  ('Supplies', 'supplies', '#caa6f0'),
  ('Utilities', 'utilities', '#f7f3e6'),
  ('Equipment', 'equipment', '#ecd95a'),
  ('Revenue', 'revenue', '#ffffff')
) AS v(name, tax_code, color)
ON CONFLICT (business_id, name) DO NOTHING;
