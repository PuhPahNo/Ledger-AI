import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { getEnv } from '../config/env.js';
import * as schema from './schema.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: getEnv().DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
    });
  }
  return pool;
}

export const db = drizzle(getPool(), { schema });

export async function closeDb(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
}
