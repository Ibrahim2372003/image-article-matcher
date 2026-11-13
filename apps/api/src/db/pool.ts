import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import type { Env } from "../env.js";
import { buildPoolConfig, redactSecrets } from "./config.js";

let pool: Pool | undefined;
let closing: Promise<void> | undefined;

/** Lazily creates the process-wide pool. Does not connect until the first query. */
export function getPool(env: Env): Pool {
  if (!pool) {
    const created = new Pool(buildPoolConfig(env));
    // An idle client can error (e.g. DB restart). Without this handler the process would crash.
    created.on("error", (err) => {
      console.error(
        JSON.stringify({
          level: "error",
          msg: "idle pg client error",
          error: redactSecrets(err.message, env.DATABASE_URL),
        }),
      );
    });
    pool = created;
  }
  return pool;
}

/** Always parameterized: values go in `params`, never concatenated into `text`. */
export function query<R extends QueryResultRow = QueryResultRow>(
  db: Pick<Pool, "query">,
  text: string,
  params: readonly unknown[] = [],
): Promise<QueryResult<R>> {
  return db.query<R>(text, params as unknown[]);
}

/** Runs `fn` in a transaction; rolls back on any error and always releases the client. */
export async function withTransaction<T>(
  db: Pick<Pool, "connect">,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* connection is already broken; surface the original error */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function checkDatabase(db: Pick<Pool, "query">): Promise<boolean> {
  try {
    await db.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

/** Idempotent graceful close: waits for checked-out clients, then ends the pool once. */
export function closePool(): Promise<void> {
  if (!pool) return Promise.resolve();
  if (!closing) {
    const p = pool;
    closing = p.end().finally(() => {
      pool = undefined;
      closing = undefined;
    });
  }
  return closing;
}
