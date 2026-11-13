import { fileURLToPath } from "node:url";
import { redactSecrets, describeDatabase } from "./config.js";
import { loadMigrations, migrationStatus, runMigrations } from "./migrate.js";
import { closePool, getPool } from "./pool.js";
import { loadEnv } from "../env.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

async function main(): Promise<number> {
  const command = process.argv[2] ?? "up";
  if (command !== "up" && command !== "status") {
    console.error("Usage: db:migrate [up|status]");
    return 2;
  }
  const env = loadEnv();
  try {
    const migrations = await loadMigrations(MIGRATIONS_DIR);
    const pool = getPool(env);
    const client = await pool.connect(); // one dedicated session: advisory lock + transactions
    try {
      console.log(`target: ${describeDatabase(env.DATABASE_URL)}`);
      if (command === "status") {
        const s = await migrationStatus(client, migrations);
        console.log(`applied: ${s.applied.length}, pending: ${s.pending.length}`);
        for (const m of s.pending) console.log(`  pending ${m.filename}`);
      } else {
        const r = await runMigrations(client, migrations, (m) => console.log(m));
        console.log(r.applied.length === 0 ? "up to date" : `applied ${r.applied.length} migration(s)`);
      }
    } finally {
      client.release();
    }
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`migration failed: ${redactSecrets(msg, env.DATABASE_URL)}`);
    return 1;
  } finally {
    await closePool();
  }
}

process.exitCode = await main();
