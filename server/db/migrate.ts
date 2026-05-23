import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, closeDb } from './client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, 'migrations');

export async function migrate(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await fs.readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const applied = await pool.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file]);
    if (applied.rowCount) continue;
    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    console.log(`Applying migration ${file}`);
    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await pool.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await pool.query('COMMIT');
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => closeDb())
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
