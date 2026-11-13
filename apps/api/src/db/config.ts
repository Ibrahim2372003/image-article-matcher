import type { PoolConfig } from "pg";
import type { Env } from "../env.js";

type DbEnv = Pick<
  Env,
  "DATABASE_URL" | "DB_POOL_MAX" | "DB_IDLE_TIMEOUT_MS" | "DB_CONNECT_TIMEOUT_MS" | "DB_STATEMENT_TIMEOUT_MS" | "DB_SSL"
>;

/** Pool settings with bounded size and timeouts so a stuck query or DB outage cannot hang the API forever. */
export function buildPoolConfig(env: DbEnv, applicationName = "iam-api"): PoolConfig {
  return {
    connectionString: env.DATABASE_URL,
    max: env.DB_POOL_MAX,
    idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: env.DB_CONNECT_TIMEOUT_MS,
    statement_timeout: env.DB_STATEMENT_TIMEOUT_MS,
    application_name: applicationName,
    ssl: env.DB_SSL === "require" ? { rejectUnauthorized: true } : undefined,
  };
}

/** Safe-to-log description of the target database: never includes the user's password. */
export function describeDatabase(databaseUrl: string): string {
  try {
    const u = new URL(databaseUrl);
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

/** Removes the connection string and its password from any message before it is logged. */
export function redactSecrets(message: string, databaseUrl: string): string {
  let out = message.split(databaseUrl).join("[redacted-url]");
  try {
    const { password, username } = new URL(databaseUrl);
    const pw = decodeURIComponent(password);
    if (pw.length > 0) out = out.split(pw).join("[redacted]").split(password).join("[redacted]");
    if (username.length > 0 && out.includes(`${username}:`)) out = out.split(`${username}:`).join("[user]:");
  } catch {
    /* not a URL: only the full-string replacement above applies */
  }
  return out;
}
