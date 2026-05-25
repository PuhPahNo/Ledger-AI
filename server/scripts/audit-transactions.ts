import { sql } from 'drizzle-orm';
import { closeDb, db } from '../db/client.js';

type Row = Record<string, unknown>;

async function main(): Promise<void> {
  console.log('Ledger AI transaction audit');
  console.log('Read-only checks for direction, transfers, category drift, and history coverage.\n');

  await printQuery('Direction totals', sql`
    SELECT
      count(*)::int AS total_rows,
      count(*) FILTER (WHERE amount_cents > 0)::int AS inflow_rows,
      coalesce(sum(amount_cents) FILTER (WHERE amount_cents > 0), 0)::int AS inflow_cents,
      count(*) FILTER (WHERE amount_cents < 0)::int AS outflow_rows,
      coalesce(abs(sum(amount_cents) FILTER (WHERE amount_cents < 0)), 0)::int AS outflow_cents,
      count(*) FILTER (WHERE amount_cents = 0)::int AS zero_rows,
      min(date) AS oldest_date,
      max(date) AS newest_date
    FROM transactions
  `);

  await printQuery('Operating vs transfer movement', sql`
    SELECT
      count(*) FILTER (WHERE transactions.amount_cents < 0 AND coalesce(categories.tax_code, '') NOT LIKE 'exclude_%')::int AS operating_outflow_rows,
      coalesce(abs(sum(transactions.amount_cents) FILTER (WHERE transactions.amount_cents < 0 AND coalesce(categories.tax_code, '') NOT LIKE 'exclude_%')), 0)::int AS operating_outflow_cents,
      count(*) FILTER (WHERE coalesce(categories.tax_code, '') LIKE 'exclude_%')::int AS transfer_rows,
      coalesce(abs(sum(transactions.amount_cents) FILTER (WHERE coalesce(categories.tax_code, '') LIKE 'exclude_%')), 0)::int AS transfer_movement_cents
    FROM transactions
    LEFT JOIN categories ON transactions.category_id = categories.id
  `);

  await printQuery('Direction/category mismatches', sql`
    SELECT
      count(*) FILTER (
        WHERE transactions.amount_cents > 0
          AND (
            categories.id IS NULL
            OR NOT (categories.tax_code = 'income' OR lower(categories.name) IN ('income', 'revenue'))
          )
      )::int AS inflows_not_income,
      count(*) FILTER (
        WHERE transactions.amount_cents < 0
          AND (categories.tax_code = 'income' OR lower(categories.name) IN ('income', 'revenue'))
      )::int AS outflows_in_income,
      count(*) FILTER (
        WHERE transactions.amount_cents < 0
          AND coalesce(categories.tax_code, '') LIKE 'exclude_%'
          AND transactions.receipt_status <> 'n/a'
      )::int AS transfer_receipt_mismatches
    FROM transactions
    LEFT JOIN categories ON transactions.category_id = categories.id
  `);

  await printQuery('Oldest transaction by active Plaid account', sql`
    SELECT
      connections.id AS connection_id,
      connections.label AS connection,
      accounts.id AS account_id,
      accounts.name AS account,
      accounts.mask,
      accounts.enabled,
      min(transactions.date) AS oldest_date,
      max(transactions.date) AS newest_date,
      count(transactions.id)::int AS transaction_rows
    FROM connections
    INNER JOIN accounts ON accounts.connection_id = connections.id
    LEFT JOIN transactions ON transactions.account_id = accounts.id
    WHERE connections.kind <> 'gmail'
      AND connections.status <> 'disconnected'
    GROUP BY connections.id, connections.label, accounts.id, accounts.name, accounts.mask, accounts.enabled
    ORDER BY oldest_date NULLS LAST, connections.label, accounts.name
  `);
}

async function printQuery(label: string, query: ReturnType<typeof sql>): Promise<void> {
  const result = await db.execute(query);
  console.log(label);
  console.table(result.rows as Row[]);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDb();
  });
