import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getPool } from "./pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.join(__dirname, "migrations");

/** Pure — lists migration files in numeric filename order. No DB, no network. */
export function listMigrationFiles(dir = MIGRATIONS_DIR) {
  return readdirSync(dir)
    .filter((filename) => filename.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

async function ensureMigrationsTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

/**
 * Applies every migration not yet recorded, each in its own
 * transaction, in filename order. Execution against a real database is
 * NOT VERIFIED in this environment — see EVIDENCE.md.
 */
export async function runMigrations({ pool = getPool(), dir = MIGRATIONS_DIR } = {}) {
  await ensureMigrationsTable(pool);
  const { rows } = await pool.query("SELECT id FROM schema_migrations");
  const applied = new Set(rows.map((row) => row.id));

  const newlyApplied = [];
  for (const file of listMigrationFiles(dir)) {
    if (applied.has(file)) continue;

    const sql = readFileSync(path.join(dir, file), "utf-8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
      await client.query("COMMIT");
      newlyApplied.push(file);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${file} failed and was rolled back: ${err.message}`);
    } finally {
      client.release();
    }
  }

  return { applied: newlyApplied, alreadyApplied: [...applied] };
}

const isDirectlyExecuted = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectlyExecuted) {
  runMigrations()
    .then(({ applied, alreadyApplied }) => {
      console.log(`Applied ${applied.length} new migration(s): ${applied.join(", ") || "(none)"}`);
      console.log(`Already applied: ${alreadyApplied.length ? alreadyApplied.join(", ") : "(none)"}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("Migration failed:", err.message);
      process.exit(1);
    });
}
