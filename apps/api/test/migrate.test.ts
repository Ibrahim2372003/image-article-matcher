import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DECISIONS, EMBEDDING_DIMENSION, JOB_STATUSES } from "@iam/shared";
import {
  MIGRATION_LOCK_KEY,
  MigrationError,
  buildMigration,
  checksumOf,
  loadMigrations,
  parseMigrationFilename,
  planMigrations,
  runMigrations,
  validateSequence,
  type Migration,
  type Queryable,
} from "../src/db/migrate.js";

const DIR = fileURLToPath(new URL("../migrations", import.meta.url));
const mig = (v: number, sql = "SELECT 1") => buildMigration(`${String(v).padStart(3, "0")}_step_${v}.sql`, sql);

/** In-memory fake of a single pg session; records every statement. */
function fakeDb(opts: { applied?: Migration[]; failOn?: (sql: string) => boolean } = {}) {
  const log: string[] = [];
  const applied = (opts.applied ?? []).map((m) => ({ version: m.version, name: m.name, checksum: m.checksum }));
  const db: Queryable = {
    async query(text, params) {
      const t = text.trim();
      log.push(t.split("\n")[0] ?? t);
      if (opts.failOn?.(t)) throw new Error("boom: " + t.slice(0, 20));
      if (t.startsWith("SELECT version, name, checksum")) return { rows: applied.map((a) => ({ ...a })) };
      if (t.startsWith("INSERT INTO schema_migrations")) {
        const [version, name, checksum] = params as [number, string, string];
        applied.push({ version, name, checksum });
      }
      return { rows: [] };
    },
  };
  return { db, log, applied };
}

describe("migration files", () => {
  it("parses valid names and rejects invalid ones", () => {
    expect(parseMigrationFilename("001_init.sql")).toEqual({ version: 1, name: "init" });
    expect(parseMigrationFilename("1_init.sql")).toBeNull();
    expect(parseMigrationFilename("001_Init.sql")).toBeNull();
    expect(() => buildMigration("bad.sql", "")).toThrow(MigrationError);
  });
  it("checksum ignores CRLF differences", () => {
    expect(checksumOf("a\r\nb")).toBe(checksumOf("a\nb"));
  });
  it("detects gaps and duplicates", () => {
    expect(() => validateSequence([mig(1), mig(3)])).toThrow(/contiguous/);
    expect(() => validateSequence([mig(1), buildMigration("001_other.sql", "x")])).toThrow(/Duplicate/);
  });
  it("honours the no-transaction directive", () => {
    expect(buildMigration("002_x.sql", "-- migrate:no-transaction\nSELECT 1").transactional).toBe(false);
    expect(mig(2).transactional).toBe(true);
  });
  it("loads the real migrations directory", async () => {
    const all = await loadMigrations(DIR);
    expect(all.length).toBeGreaterThanOrEqual(1);
    expect(all[0]?.filename).toBe("001_init.sql");
  });
});

describe("schema stays in sync with shared constants", () => {
  it("vector column dimension, job statuses and decisions match @iam/shared", async () => {
    const sql = (await loadMigrations(DIR)).map((m) => m.sql).join("\n");
    expect(sql).toContain(`vector(${EMBEDDING_DIMENSION})`);
    for (const s of JOB_STATUSES) expect(sql).toContain(`'${s}'`);
    for (const d of DECISIONS) expect(sql).toContain(`'${d}'`);
  });
});

describe("planMigrations", () => {
  it("returns only pending migrations in order", () => {
    const all = [mig(1), mig(2), mig(3)];
    expect(
      planMigrations(
        all,
        [all[0]!].map(({ version, name, checksum }) => ({ version, name, checksum })),
      ).map((m) => m.version),
    ).toEqual([2, 3]);
  });
  it("rejects edited applied migrations", () => {
    const m = mig(1);
    expect(() => planMigrations([m], [{ version: 1, name: m.name, checksum: "deadbeef" }])).toThrow(
      /modified after being applied/,
    );
  });
  it("rejects applied versions with no file", () => {
    expect(() => planMigrations([], [{ version: 1, name: "x", checksum: "y" }])).toThrow(/no file/);
  });
});

describe("runMigrations", () => {
  it("applies pending migrations transactionally, records them, and takes/releases the lock", async () => {
    const { db, log, applied } = fakeDb();
    const res = await runMigrations(db, [mig(1, "CREATE X"), mig(2, "CREATE Y")]);
    expect(res.applied.map((m) => m.version)).toEqual([1, 2]);
    expect(applied.map((a) => a.version)).toEqual([1, 2]);
    expect(log[0]).toContain("pg_advisory_lock");
    expect(log.at(-1)).toContain("pg_advisory_unlock");
    expect(log.filter((l) => l === "BEGIN")).toHaveLength(2);
    expect(log.filter((l) => l === "COMMIT")).toHaveLength(2);
  });
  it("is a no-op when already up to date (repeatable)", async () => {
    const m = mig(1);
    const { db, log } = fakeDb({ applied: [m] });
    expect((await runMigrations(db, [m])).applied).toEqual([]);
    expect(log).not.toContain("BEGIN");
  });
  it("rolls back, does not record, stops, and unlocks when a migration fails", async () => {
    const { db, log, applied } = fakeDb({ failOn: (s) => s === "BAD SQL" });
    const err = await runMigrations(db, [mig(1, "OK SQL"), mig(2, "BAD SQL"), mig(3, "NEVER")]).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MigrationError);
    expect((err as MigrationError).code).toBe("apply_failed");
    expect((err as Error).message).toContain("002_step_2.sql");
    expect(applied.map((a) => a.version)).toEqual([1]);
    expect(log).toContain("ROLLBACK");
    expect(log).not.toContain("NEVER");
    expect(log.at(-1)).toContain("pg_advisory_unlock");
  });
  it("refuses to run when history has been tampered with", async () => {
    const m = mig(1);
    const { db } = fakeDb({ applied: [{ ...m, checksum: "other" }] });
    await expect(runMigrations(db, [m])).rejects.toMatchObject({ code: "checksum_mismatch" });
  });
  it("skips BEGIN/COMMIT for no-transaction migrations", async () => {
    const { db, log } = fakeDb();
    await runMigrations(db, [
      buildMigration("001_x.sql", "-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY i ON t(c)"),
    ]);
    expect(log).not.toContain("BEGIN");
  });
  it("uses a parameterized advisory lock key", () => {
    expect(Number.isInteger(MIGRATION_LOCK_KEY)).toBe(true);
  });
});
