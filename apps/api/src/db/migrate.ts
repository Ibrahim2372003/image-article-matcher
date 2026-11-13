import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** Minimal query surface so the runner can be unit-tested without a live database. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface Migration {
  version: number;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
  /** false only if the file starts with `-- migrate:no-transaction` (e.g. CREATE INDEX CONCURRENTLY). */
  transactional: boolean;
}

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
}

export class MigrationError extends Error {
  constructor(
    message: string,
    readonly code:
      "invalid_filename" | "duplicate_version" | "version_gap" | "checksum_mismatch" | "missing_file" | "apply_failed",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "MigrationError";
  }
}

export const MIGRATIONS_TABLE = "schema_migrations";
/** Arbitrary constant key for pg_advisory_lock so concurrent runners serialize. */
export const MIGRATION_LOCK_KEY = 727_001;
const FILENAME_RE = /^(\d{3,})_([a-z0-9_]+)\.sql$/;
const NO_TX_DIRECTIVE = /^\s*--\s*migrate:no-transaction\b/;

export function parseMigrationFilename(filename: string): { version: number; name: string } | null {
  const m = FILENAME_RE.exec(filename);
  if (!m) return null;
  return { version: Number(m[1]), name: m[2] as string };
}

export function checksumOf(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

export function buildMigration(filename: string, sql: string): Migration {
  const parsed = parseMigrationFilename(filename);
  if (!parsed) {
    throw new MigrationError(
      `Invalid migration filename "${filename}" (expected NNN_snake_case.sql)`,
      "invalid_filename",
    );
  }
  return { ...parsed, filename, sql, checksum: checksumOf(sql), transactional: !NO_TX_DIRECTIVE.test(sql) };
}

/** Reads and validates `NNN_name.sql` files: unique, contiguous versions starting at 1. */
export async function loadMigrations(dir: string): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const migrations: Migration[] = [];
  for (const f of files) migrations.push(buildMigration(f, await readFile(path.join(dir, f), "utf8")));
  validateSequence(migrations);
  return migrations;
}

export function validateSequence(migrations: Migration[]): void {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  sorted.forEach((m, i) => {
    if (i > 0 && sorted[i - 1]?.version === m.version) {
      throw new MigrationError(`Duplicate migration version ${m.version}`, "duplicate_version");
    }
    if (m.version !== i + 1) {
      throw new MigrationError(
        `Migration versions must be contiguous from 1; expected ${i + 1}, found ${m.version}`,
        "version_gap",
      );
    }
  });
}

/** Pure planning step: which migrations still need to run, and is history consistent? */
export function planMigrations(available: Migration[], applied: AppliedMigration[]): Migration[] {
  const byVersion = new Map(available.map((m) => [m.version, m]));
  for (const a of applied) {
    const file = byVersion.get(a.version);
    if (!file) {
      throw new MigrationError(
        `Applied migration ${a.version} (${a.name}) has no file in the migrations directory`,
        "missing_file",
      );
    }
    if (file.checksum !== a.checksum) {
      throw new MigrationError(
        `Migration ${a.version} (${a.name}) was modified after being applied. Never edit applied migrations; add a new one.`,
        "checksum_mismatch",
      );
    }
  }
  const done = new Set(applied.map((a) => a.version));
  return available.filter((m) => !done.has(m.version)).sort((a, b) => a.version - b.version);
}

async function ensureTable(db: Queryable): Promise<void> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
       version     integer     PRIMARY KEY CHECK (version > 0),
       name        text        NOT NULL,
       checksum    text        NOT NULL,
       applied_at  timestamptz NOT NULL DEFAULT now()
     )`,
  );
}

async function readApplied(db: Queryable): Promise<AppliedMigration[]> {
  const res = await db.query(`SELECT version, name, checksum FROM ${MIGRATIONS_TABLE} ORDER BY version`);
  return res.rows.map((r) => ({ version: Number(r.version), name: String(r.name), checksum: String(r.checksum) }));
}

export interface MigrationStatus {
  applied: AppliedMigration[];
  pending: Migration[];
}

/** Read-only report. Still validates checksums so drift is visible. */
export async function migrationStatus(db: Queryable, available: Migration[]): Promise<MigrationStatus> {
  await ensureTable(db);
  const applied = await readApplied(db);
  return { applied, pending: planMigrations(available, applied) };
}

/**
 * Applies pending migrations in order. `db` MUST be a single dedicated connection (pool client), because
 * the advisory lock and BEGIN/COMMIT are session-scoped. Re-running with nothing pending is a no-op.
 */
export async function runMigrations(
  db: Queryable,
  available: Migration[],
  log: (msg: string) => void = () => {},
): Promise<{ applied: Migration[] }> {
  await db.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
  const done: Migration[] = [];
  try {
    await ensureTable(db);
    const pending = planMigrations(available, await readApplied(db));
    for (const m of pending) {
      log(`applying ${m.filename}${m.transactional ? "" : " (no transaction)"}`);
      try {
        if (m.transactional) await db.query("BEGIN");
        await db.query(m.sql);
        await db.query(`INSERT INTO ${MIGRATIONS_TABLE} (version, name, checksum) VALUES ($1, $2, $3)`, [
          m.version,
          m.name,
          m.checksum,
        ]);
        if (m.transactional) await db.query("COMMIT");
      } catch (err) {
        if (m.transactional) {
          try {
            await db.query("ROLLBACK");
          } catch {
            /* connection broken; original error is what matters */
          }
        }
        throw new MigrationError(
          `Migration ${m.filename} failed${m.transactional ? " and was rolled back" : ""}: ${errMsg(err)}`,
          "apply_failed",
          {
            cause: err,
          },
        );
      }
      done.push(m);
    }
    return { applied: done };
  } finally {
    try {
      await db.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    } catch {
      /* lock is released automatically when the session ends */
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
