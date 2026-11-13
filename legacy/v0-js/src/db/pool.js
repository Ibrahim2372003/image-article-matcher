import pg from "pg";

const { Pool } = pg;

let pool = null;

/**
 * A short connectionTimeoutMillis is deliberate: a health check (or any
 * query) that hangs for the driver's default timeout during a real
 * outage is its own production bug, independent of where this runs.
 */
export function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 2000,
    });
  }
  return pool;
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
