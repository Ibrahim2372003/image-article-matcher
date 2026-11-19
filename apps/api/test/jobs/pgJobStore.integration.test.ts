import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations, MigrationError, runMigrations, type Migration } from "../../src/db/migrate.js";
import { derivedKey, canonicalizeArticle, requestFingerprint } from "../../src/jobs/hash.js";
import { IdempotencyConflictError } from "../../src/jobs/errors.js";
import { PgJobStore } from "../../src/jobs/pgJobStore.js";
import type { JobResult, NewSubmission } from "../../src/jobs/types.js";
import { resolveGuardConfig } from "../../src/matching/guard.js";

/**
 * REAL PostgreSQL. Skipped unless TEST_DATABASE_URL is set. Every test group works in its own uniquely named
 * disposable schema (it_<random>) that this file creates and drops; `public` and existing data are never touched.
 */
const DB_URL = process.env.TEST_DATABASE_URL;
const DIR = fileURLToPath(new URL("../../migrations", import.meta.url));
const rnd = (): string => createHash("sha256").update(randomBytes(16)).digest("hex");

async function makeSchema(admin: Pool): Promise<{ schema: string; pool: Pool }> {
  const schema = `it_${randomBytes(6).toString("hex")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: DB_URL, max: 12, options: `-c search_path=${schema},public` });
  return { schema, pool };
}
async function dropSchema(admin: Pool, schema: string, pool: Pool): Promise<void> {
  await pool.end();
  if (/^it_[0-9a-f]{12}$/.test(schema)) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); // only our own temp schema
}
async function migrate(pool: Pool, upTo?: number): Promise<void> {
  const all = await loadMigrations(DIR);
  const c = await pool.connect();
  try {
    await runMigrations(c, upTo ? all.filter((m: Migration) => m.version <= upTo) : all);
  } finally {
    c.release();
  }
}

const result = (decision: "accept" | "reject" | "review"): JobResult => ({
  decision,
  similarity: 0.8,
  reasons:
    decision === "review"
      ? [{ code: "AMBIGUOUS_MATCH", severity: "review", explanation: "close call", signals: {} }]
      : [],
  signals: {
    confidence: 0.9,
    similarity: 0.8,
    rank: 1,
    margin: null,
    sharedTagCount: 1,
    imageCategory: "nature",
    articleCategory: "nature",
    primaryReasonCode: null,
    embeddingTaskType: "SEMANTIC_SIMILARITY",
  },
  policyVersion: "guard-v1",
  policyConfig: resolveGuardConfig(),
  embeddingModel: "mock-lexical-hash",
  classification: { category: "nature", tags: ["forest"], confidence: 0.9, provider: "mock", model: "mock-vision" },
});

describe.skipIf(!DB_URL)("migration 003 against pre-existing data (disposable schemas)", () => {
  let admin: Pool;
  beforeAll(() => {
    admin = new Pool({ connectionString: DB_URL, max: 1 });
  });
  afterAll(async () => {
    await admin.end();
  });

  async function seedM4(
    pool: Pool,
    extraRows: Array<{ key: string; status: string; decision: string | null; errorCode?: string | null }>,
  ) {
    const art = await pool.query<{ id: string }>(
      "INSERT INTO articles (title, body, content_hash) VALUES ('t', 'b', $1) RETURNING id",
      [rnd()],
    );
    const img = await pool.query<{ id: string }>(
      "INSERT INTO images (sha256, mime_type, byte_size, storage_path) VALUES ($1, 'image/png', 1, 'a.png') RETURNING id",
      [rnd()],
    );
    for (const r of extraRows) {
      await pool.query(
        `INSERT INTO analysis_jobs (article_id, image_id, idempotency_key, status, decision, policy_version, last_error_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          art.rows[0]!.id,
          img.rows[0]!.id,
          r.key,
          r.status,
          r.decision,
          r.decision ? "guard-v1" : null,
          r.errorCode ?? null,
        ],
      );
    }
  }

  it("backfills existing M4 rows, keeps their data, adds the constraints, and is a no-op when re-run", async () => {
    const { schema, pool } = await makeSchema(admin);
    try {
      await migrate(pool, 2);
      await seedM4(pool, [
        { key: "suggest:i:a1", status: "completed", decision: "accept" },
        { key: "suggest:i:a2", status: "needs_review", decision: "review" },
        { key: "suggest:i:a3", status: "completed", decision: "reject" },
        { key: "some-legacy-key", status: "completed", decision: "accept" }, // not an M4 key: must become a 'submission'
      ]);
      const before = await pool.query(
        "SELECT idempotency_key, status, decision FROM analysis_jobs ORDER BY idempotency_key",
      );

      await migrate(pool);

      const rows = await pool.query(
        "SELECT idempotency_key, kind, request_fingerprint, status, decision FROM analysis_jobs ORDER BY idempotency_key",
      );
      expect(rows.rows.map((r) => [r.idempotency_key, r.kind])).toEqual([
        ["some-legacy-key", "submission"],
        ["suggest:i:a1", "suggestion"],
        ["suggest:i:a2", "suggestion"],
        ["suggest:i:a3", "suggestion"],
      ]);
      expect(rows.rows[0]?.request_fingerprint).toMatch(/^backfill:/);
      expect(rows.rows.filter((r) => r.kind === "suggestion").every((r) => r.request_fingerprint === null)).toBe(true);
      // existing decisions and statuses are untouched
      expect(rows.rows.map((r) => [r.idempotency_key, r.status, r.decision])).toEqual(
        before.rows.map((r) => [r.idempotency_key, r.status, r.decision]),
      );

      const v = await pool.query("SELECT version FROM schema_migrations ORDER BY version");
      expect(v.rows.map((r) => r.version)).toEqual([1, 2, 3]);
      await migrate(pool); // re-run: nothing pending
      expect((await pool.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0]?.n).toBe(3);
    } finally {
      await dropSchema(admin, schema, pool);
    }
  });

  it("works on an EMPTY database too", async () => {
    const { schema, pool } = await makeSchema(admin);
    try {
      await migrate(pool, 2);
      await migrate(pool);
      expect((await pool.query("SELECT count(*)::int AS n FROM analysis_jobs")).rows[0]?.n).toBe(0);
    } finally {
      await dropSchema(admin, schema, pool);
    }
  });

  it("refuses to apply over a row that violates the new rules, and rolls back COMPLETELY (nothing half-applied)", async () => {
    const { schema, pool } = await makeSchema(admin);
    try {
      await migrate(pool, 2);
      // valid under 001, but forbidden by 003: a failed job that carries a decision
      await seedM4(pool, [{ key: "suggest:i:bad", status: "failed", decision: "accept", errorCode: "x" }]);
      await expect(migrate(pool)).rejects.toBeInstanceOf(MigrationError);
      expect(
        (await pool.query("SELECT version FROM schema_migrations ORDER BY version")).rows.map((r) => r.version),
      ).toEqual([1, 2]);
      const cols = await pool.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'analysis_jobs' AND column_name IN ('kind','enqueued_at','request_fingerprint')",
        [schema],
      );
      expect(cols.rowCount).toBe(0); // the ALTER TABLE was rolled back with the failed migration
      const tbl = await pool.query("SELECT to_regclass($1 || '.ai_usage') AS t", [schema]);
      expect(tbl.rows[0]?.t).toBeNull();
    } finally {
      await dropSchema(admin, schema, pool);
    }
  });
});

describe.skipIf(!DB_URL)("PgJobStore on real PostgreSQL (disposable schema)", () => {
  let admin: Pool;
  let pool: Pool;
  let schema = "";
  let store: PgJobStore;

  const submission = (over: Partial<NewSubmission> = {}, tag = rnd()): NewSubmission => {
    const article = canonicalizeArticle({
      title: `title ${tag}`,
      body: `body ${tag}`,
      category: "nature",
      tags: ["forest"],
    });
    const sha = rnd();
    return {
      article,
      image: { sha256: sha, mimeType: "image/png", byteSize: 10, storagePath: `${sha}.png` },
      idempotencyKey: derivedKey(article.contentHash, sha),
      fingerprint: requestFingerprint(article.contentHash, sha),
      maxAttempts: 3,
      ...over,
    };
  };
  const row = async (id: string) => (await pool.query("SELECT * FROM analysis_jobs WHERE id = $1", [id])).rows[0];
  const events = async (id: string) =>
    (
      await pool.query(
        "SELECT event_type, from_status, to_status, details FROM job_audit_events WHERE job_id = $1 ORDER BY id",
        [id],
      )
    ).rows;

  beforeAll(async () => {
    admin = new Pool({ connectionString: DB_URL, max: 1 });
    ({ schema, pool } = await makeSchema(admin));
    await migrate(pool);
    store = new PgJobStore(pool);
  });
  afterAll(async () => {
    await dropSchema(admin, schema, pool);
    await admin.end();
  });

  describe("idempotent submission", () => {
    it("creates article, image and a queued job with an audit event; a replay returns the same job", async () => {
      const s = submission();
      const a = await store.createSubmission(s);
      expect(a.outcome).toBe("created");
      expect(a.job).toMatchObject({ status: "queued", attempts: 0, maxAttempts: 3, enqueuedAt: null });
      expect((await events(a.job.id)).map((e) => e.event_type)).toEqual(["job_submitted"]);
      const b = await store.createSubmission(s);
      expect(b.outcome).toBe("replayed");
      expect(b.job.id).toBe(a.job.id);
      expect(
        (
          await pool.query("SELECT count(*)::int AS n FROM analysis_jobs WHERE idempotency_key = $1", [
            s.idempotencyKey,
          ])
        ).rows[0]?.n,
      ).toBe(1);
      expect((await events(a.job.id)).length).toBe(1); // a replay writes no new audit event
    });

    it("reusing a key with a DIFFERENT payload is a conflict and creates nothing", async () => {
      const s = submission({ idempotencyKey: `client:${rnd().slice(0, 20)}` });
      const first = await store.createSubmission(s);
      const other = submission({ idempotencyKey: s.idempotencyKey });
      const err = await store.createSubmission(other).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IdempotencyConflictError);
      expect((err as IdempotencyConflictError).existingJobId).toBe(first.job.id);
      expect(
        (
          await pool.query("SELECT count(*)::int AS n FROM analysis_jobs WHERE idempotency_key = $1", [
            s.idempotencyKey,
          ])
        ).rows[0]?.n,
      ).toBe(1);
    });

    it("12 CONCURRENT submissions with the same key create exactly one job", async () => {
      const s = submission();
      const results = await Promise.all(Array.from({ length: 12 }, () => store.createSubmission(s)));
      expect(results.filter((r) => r.outcome === "created")).toHaveLength(1);
      expect(new Set(results.map((r) => r.job.id)).size).toBe(1);
      expect(
        (
          await pool.query("SELECT count(*)::int AS n FROM analysis_jobs WHERE idempotency_key = $1", [
            s.idempotencyKey,
          ])
        ).rows[0]?.n,
      ).toBe(1);
      expect((await events(results[0]!.job.id)).filter((e) => e.event_type === "job_submitted")).toHaveLength(1);
    });

    it("identical article and image under two different keys share the article/image rows but are separate jobs", async () => {
      const s1 = submission({ idempotencyKey: `client:${rnd().slice(0, 16)}` });
      const s2 = { ...s1, idempotencyKey: `client:${rnd().slice(0, 16)}` };
      const a = await store.createSubmission(s1);
      const b = await store.createSubmission(s2);
      expect(a.job.id).not.toBe(b.job.id);
      expect(a.job.articleId).toBe(b.job.articleId);
      expect(a.job.imageId).toBe(b.job.imageId);
    });
  });

  describe("claim, attempts and fencing", () => {
    it("claims queued -> processing with attempts+1 and audits it", async () => {
      const { job } = await store.createSubmission(submission());
      const c = await store.claim(job.id);
      expect(c).toMatchObject({ kind: "claimed", attempt: 1 });
      expect(await row(job.id)).toMatchObject({ status: "processing", attempts: 1 });
      expect((await events(job.id)).map((e) => e.event_type)).toEqual(["job_submitted", "job_claimed"]);
    });

    it("a redelivery re-claims a processing job (crash recovery) with attempts+1", async () => {
      const { job } = await store.createSubmission(submission());
      await store.claim(job.id);
      expect(await store.claim(job.id)).toMatchObject({ kind: "claimed", attempt: 2 });
    });

    it("the attempt limit holds: when attempts are used up the job FAILS instead of running again", async () => {
      const { job } = await store.createSubmission(submission({ maxAttempts: 2 }));
      await store.claim(job.id);
      await store.claim(job.id);
      expect(await store.claim(job.id)).toEqual({ kind: "exhausted" });
      expect(await row(job.id)).toMatchObject({
        status: "failed",
        decision: null,
        last_error_code: "attempts_exceeded",
        attempts: 2,
      });
      expect((await events(job.id)).at(-1)).toMatchObject({ event_type: "job_failed", to_status: "failed" });
    });

    it("claiming a missing job or a non-submission row reports missing", async () => {
      expect(await store.claim("00000000-0000-4000-8000-000000000000")).toEqual({ kind: "missing" });
    });

    it("STALE WORKER FENCING: an older attempt can neither commit, retry nor fail the job", async () => {
      const { job } = await store.createSubmission(submission());
      await store.claim(job.id); // attempt 1 (this worker later becomes a zombie)
      await store.claim(job.id); // attempt 2 supersedes it
      expect(await store.commitResult(job.id, 1, result("accept"))).toBe(false);
      expect(await store.recordRetry(job.id, 1, { code: "provider_timeout", retryable: true, message: "x" })).toBe(
        false,
      );
      expect(
        await store.failPermanently(job.id, 1, { code: "x", retryable: false, message: "x" }, { exhausted: false }),
      ).toBe(false);
      expect(await row(job.id)).toMatchObject({ status: "processing", attempts: 2, decision: null });
      expect(await store.commitResult(job.id, 2, result("accept"))).toBe(true);
      expect(await row(job.id)).toMatchObject({ status: "completed", decision: "accept" });
    });

    it("TWELVE concurrent claims: attempts advance by exactly 12 and never exceed the bound (no lost updates)", async () => {
      const { job } = await store.createSubmission(submission({ maxAttempts: 10 }));
      const out = await Promise.all(Array.from({ length: 12 }, () => store.claim(job.id)));
      expect(out.filter((o) => o.kind === "claimed")).toHaveLength(10);
      expect(out.filter((o) => o.kind === "exhausted" || o.kind === "terminal")).toHaveLength(2);
      const attempts = out.flatMap((o) => (o.kind === "claimed" ? [o.attempt] : [])).sort((a, b) => a - b);
      expect(attempts).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); // each attempt number handed out once
      expect((await row(job.id)).attempts).toBeLessThanOrEqual(10);
    });
  });

  describe("results, retries and failures", () => {
    it("accept/reject -> completed, review -> needs_review; the whole result is persisted atomically with an audit event", async () => {
      for (const [d, status] of [
        ["accept", "completed"],
        ["reject", "completed"],
        ["review", "needs_review"],
      ] as const) {
        const { job } = await store.createSubmission(submission());
        const c = await store.claim(job.id);
        expect(c.kind).toBe("claimed");
        expect(await store.commitResult(job.id, 1, result(d))).toBe(true);
        expect(await row(job.id)).toMatchObject({
          status,
          decision: d,
          policy_version: "guard-v1",
          embedding_model: "mock-lexical-hash",
          last_error_code: null,
        });
        expect((await events(job.id)).at(-1)).toMatchObject({ event_type: "job_completed", to_status: status });
      }
    });

    it("a retryable failure returns the job to queued with the error recorded; the next claim continues the attempt count", async () => {
      const { job } = await store.createSubmission(submission());
      await store.claim(job.id);
      expect(
        await store.recordRetry(job.id, 1, { code: "provider_timeout", retryable: true, message: "timed out" }),
      ).toBe(true);
      expect(await row(job.id)).toMatchObject({
        status: "queued",
        attempts: 1,
        last_error_code: "provider_timeout",
        decision: null,
      });
      expect((await events(job.id)).at(-1)).toMatchObject({
        event_type: "retry_scheduled",
        from_status: "processing",
        to_status: "queued",
      });
      expect(await store.claim(job.id)).toMatchObject({ kind: "claimed", attempt: 2 });
      expect(await store.commitResult(job.id, 2, result("accept"))).toBe(true);
      expect(await row(job.id)).toMatchObject({ last_error_code: null }); // transient error cleared; history stays in the audit trail
      expect((await events(job.id)).map((e) => e.event_type)).toEqual([
        "job_submitted",
        "job_claimed",
        "retry_scheduled",
        "job_claimed",
        "job_completed",
      ]);
    });

    it("a permanent failure -> failed with a stable code and NO decision", async () => {
      const { job } = await store.createSubmission(submission());
      await store.claim(job.id);
      expect(
        await store.failPermanently(
          job.id,
          1,
          { code: "provider_invalid_embedding", retryable: false, message: "1024 values" },
          { exhausted: false },
        ),
      ).toBe(true);
      expect(await row(job.id)).toMatchObject({
        status: "failed",
        decision: null,
        similarity: null,
        last_error_code: "provider_invalid_embedding",
      });
      expect((await events(job.id)).at(-1)).toMatchObject({
        event_type: "job_failed",
        details: { code: "provider_invalid_embedding", exhausted: false },
      });
    });

    it("terminal jobs are never processed again", async () => {
      for (const finish of [
        (id: string) => store.commitResult(id, 1, result("accept")),
        (id: string) => store.commitResult(id, 1, result("review")),
        (id: string) =>
          store.failPermanently(id, 1, { code: "x", retryable: false, message: "x" }, { exhausted: false }),
      ]) {
        const { job } = await store.createSubmission(submission());
        await store.claim(job.id);
        await finish(job.id);
        const status = (await row(job.id)).status;
        expect(await store.claim(job.id)).toEqual({ kind: "terminal", status });
        expect(await store.commitResult(job.id, 1, result("reject"))).toBe(false);
      }
    });
  });

  describe("database-level guards (a second line of defence behind the guarded UPDATEs)", () => {
    const raw = (sql: string, params: unknown[]) => pool.query(sql, params);
    it("rejects illegal status transitions", async () => {
      const { job } = await store.createSubmission(submission());
      await expect(raw("UPDATE analysis_jobs SET status = 'completed' WHERE id = $1", [job.id])).rejects.toThrow(
        /illegal job status transition queued -> completed/,
      );
      await store.claim(job.id);
      await store.commitResult(job.id, 1, result("accept"));
      await expect(raw("UPDATE analysis_jobs SET status = 'processing' WHERE id = $1", [job.id])).rejects.toThrow(
        /illegal job status transition completed -> processing/,
      );
      await expect(raw("UPDATE analysis_jobs SET status = 'failed' WHERE id = $1", [job.id])).rejects.toThrow(
        /illegal/,
      );
    });
    it("a failed job cannot carry a decision, and open jobs cannot either", async () => {
      const { job } = await store.createSubmission(submission());
      await expect(
        raw("UPDATE analysis_jobs SET decision = 'accept', policy_version = 'v' WHERE id = $1", [job.id]),
      ).rejects.toThrow(/analysis_jobs_open_no_decision/);
      await store.claim(job.id);
      await store.failPermanently(job.id, 1, { code: "x", retryable: false, message: "x" }, { exhausted: false });
      await expect(
        raw("UPDATE analysis_jobs SET decision = 'accept', policy_version = 'v' WHERE id = $1", [job.id]),
      ).rejects.toThrow(/analysis_jobs_failed_no_decision/);
    });
    it("kind is immutable and must match the key namespace", async () => {
      const { job } = await store.createSubmission(submission());
      await expect(raw("UPDATE analysis_jobs SET kind = 'suggestion' WHERE id = $1", [job.id])).rejects.toThrow(
        /kind is immutable/,
      );
      const s = submission();
      await expect(
        raw(
          `INSERT INTO analysis_jobs (article_id, image_id, idempotency_key, kind, request_fingerprint) VALUES ($1, $2, 'suggest:x:y', 'submission', 'f')`,
          [job.articleId, job.imageId],
        ),
      ).rejects.toThrow(/analysis_jobs_kind_matches_key/);
      expect(s).toBeDefined();
    });
    it("attempts can never exceed max_attempts", async () => {
      const { job } = await store.createSubmission(submission({ maxAttempts: 2 }));
      await expect(raw("UPDATE analysis_jobs SET attempts = 3 WHERE id = $1", [job.id])).rejects.toThrow(
        /attempts_le_max/,
      );
    });
  });

  describe("AI usage accounting", () => {
    it("records real calls, failures included; an UNKNOWN cost is reported as unknown, never as zero", async () => {
      const { job } = await store.createSubmission(submission());
      const base = { jobId: job.id, attempt: 1, provider: "mock", model: "m", latencyMs: 12.7 };
      await store.recordUsage({
        ...base,
        operation: "classify_image",
        success: true,
        errorCode: null,
        usage: { inputTokens: 100, outputTokens: 20, estimated: false },
        estimatedCostUsd: null,
        costBasis: "no_rate_configured",
      });
      await store.recordUsage({
        ...base,
        operation: "embed_image",
        success: false,
        errorCode: "provider_timeout",
        usage: null,
        estimatedCostUsd: null,
        costBasis: "tokens_unavailable",
      });
      const v = await store.getJobView(job.id);
      expect(v?.usage).toEqual({
        calls: 2,
        failedCalls: 1,
        inputTokens: 100,
        outputTokens: 20,
        tokensEstimated: false,
        estimatedCostUsd: null,
        costComplete: false,
      });
    });
    it("sums only KNOWN costs and says the total is incomplete when any call's cost is unknown", async () => {
      const { job } = await store.createSubmission(submission());
      const base = {
        jobId: job.id,
        attempt: 1,
        provider: "gemini",
        model: "m",
        latencyMs: 5,
        success: true,
        errorCode: null,
      };
      await store.recordUsage({
        ...base,
        operation: "classify_image",
        usage: { inputTokens: 1000, outputTokens: 100, estimated: false },
        estimatedCostUsd: 0.00125,
        costBasis: "configured_rate_estimate",
      });
      await store.recordUsage({
        ...base,
        operation: "embed_image",
        usage: { inputTokens: 10, outputTokens: 0, estimated: true },
        estimatedCostUsd: null,
        costBasis: "tokens_unavailable",
      });
      const u = (await store.getJobView(job.id))!.usage;
      expect(u).toMatchObject({ estimatedCostUsd: 0.00125, costComplete: false, tokensEstimated: true });
    });
    it("a job with no AI calls (all results reused) reports zero calls and no cost figure", async () => {
      const { job } = await store.createSubmission(submission());
      expect((await store.getJobView(job.id))!.usage).toEqual({
        calls: 0,
        failedCalls: 0,
        inputTokens: null,
        outputTokens: null,
        tokensEstimated: false,
        estimatedCostUsd: null,
        costComplete: true,
      });
    });
    it("the database refuses a cost that is inconsistent with its basis, and a failure without an error code", async () => {
      const { job } = await store.createSubmission(submission());
      const ins = (cost: number | null, basis: string, success: boolean, code: string | null) =>
        pool.query(
          `INSERT INTO ai_usage (job_id, attempt, operation, provider, model, success, error_code, latency_ms, estimated_cost_usd, cost_basis)
           VALUES ($1, 1, 'classify_image', 'p', 'm', $2, $3, 1, $4, $5)`,
          [job.id, success, code, cost, basis],
        );
      await expect(ins(0, "no_rate_configured", true, null)).rejects.toThrow(/cost_matches_basis/); // "zero" with no rate = invented
      await expect(ins(null, "configured_rate_estimate", true, null)).rejects.toThrow(/cost_matches_basis/);
      await expect(ins(null, "no_rate_configured", false, null)).rejects.toThrow(/failure_has_code/);
    });
  });

  describe("views, enqueue marker and reconciliation", () => {
    it("getJobView exposes a failed job with a null decision, and hides milestone-4 suggestion rows", async () => {
      const { job } = await store.createSubmission(submission());
      await store.claim(job.id);
      await store.failPermanently(
        job.id,
        1,
        { code: "provider_config", retryable: false, message: "no key" },
        { exhausted: false },
      );
      const v = (await store.getJobView(job.id))!;
      expect(v).toMatchObject({
        status: "failed",
        decision: null,
        error: { code: "provider_config", message: "no key" },
        kind: "submission",
      });
      await pool.query(
        "INSERT INTO analysis_jobs (article_id, image_id, idempotency_key, kind, status, decision, policy_version) VALUES ($1, $2, 'suggest:view:test', 'suggestion', 'completed', 'accept', 'guard-v1')",
        [job.articleId, job.imageId],
      );
      const sug = await pool.query<{ id: string }>(
        "SELECT id FROM analysis_jobs WHERE idempotency_key = 'suggest:view:test'",
      );
      expect(await store.getJobView(sug.rows[0]!.id)).toBeNull();
      expect(await store.claim(sug.rows[0]!.id)).toEqual({ kind: "missing" }); // workers never touch suggestion rows
    });

    it("markEnqueued records the publication; a never-published job stays visible to the reconciler", async () => {
      const { job } = await store.createSubmission(submission());
      expect((await row(job.id)).enqueued_at).toBeNull();
      await store.markEnqueued(job.id, "api");
      expect((await row(job.id)).enqueued_at).not.toBeNull();
      expect((await events(job.id)).map((e) => e.event_type)).toContain("job_enqueued");
    });

    it("finds stale queued/processing submissions, ignores fresh and terminal ones, and does not re-select a requeued job", async () => {
      const q = (await store.createSubmission(submission())).job; // stays queued (publication "failed")
      const p = (await store.createSubmission(submission())).job;
      await store.claim(p.id); // stuck in processing
      const done = (await store.createSubmission(submission())).job;
      await store.claim(done.id);
      await store.commitResult(done.id, 1, result("accept"));
      await new Promise((r) => setTimeout(r, 30));

      const ids = (await store.findReconcileCandidates({ queuedStaleMs: 10, processingStaleMs: 10, limit: 500 })).map(
        (c) => c.id,
      );
      expect(ids).toEqual(expect.arrayContaining([q.id, p.id]));
      expect(ids).not.toContain(done.id);

      const fresh = (
        await store.findReconcileCandidates({ queuedStaleMs: 60_000, processingStaleMs: 60_000, limit: 500 })
      ).map((c) => c.id);
      expect(fresh).not.toContain(q.id);

      await store.recordRequeued(q.id, "queued");
      const after = (await store.findReconcileCandidates({ queuedStaleMs: 20, processingStaleMs: 20, limit: 500 })).map(
        (c) => c.id,
      );
      expect(after).not.toContain(q.id); // touching updated_at removes it from this pass
      expect((await events(q.id)).at(-1)).toMatchObject({ event_type: "job_requeued" });
    });

    it("respects the candidate limit", async () => {
      const c = await store.findReconcileCandidates({ queuedStaleMs: 0, processingStaleMs: 0, limit: 2 });
      expect(c.length).toBeLessThanOrEqual(2);
    });
  });
});
