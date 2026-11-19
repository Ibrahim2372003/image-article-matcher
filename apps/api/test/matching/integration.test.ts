import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMBEDDING_TASK_TYPE } from "@iam/shared";
import { createMockProvider, lexicalHashEmbed } from "../../src/ai/index.js";
import { loadMigrations, runMigrations } from "../../src/db/migrate.js";
import {
  IncompatibleEmbeddingModelError,
  PgMatchStore,
  cosineSimilarity,
  buildArticleEmbeddingText,
  buildImageEmbeddingText,
  ensureArticleEmbedding,
  ensureImageClassification,
  ensureImageEmbedding,
  generateMatches,
  resolveGuardConfig,
  type EvaluationRecord,
} from "../../src/matching/index.js";

/**
 * REAL PostgreSQL + pgvector. Skipped unless TEST_DATABASE_URL is set. Everything runs inside a uniquely named,
 * disposable schema (it_<random>) that this file creates and drops; the `public` schema and existing data are never
 * touched. Point TEST_DATABASE_URL at a scratch database anyway.
 */
const DB_URL = process.env.TEST_DATABASE_URL;
const DIR = fileURLToPath(new URL("../../migrations", import.meta.url));
const loose = resolveGuardConfig({ minSimilarity: 0.2, minMargin: 0 }); // lexical mock vectors are modest in similarity
const strict = resolveGuardConfig({ minSimilarity: 1, minMargin: 0 }); // would reject everything
const loadImage = async () => ({ base64: "aGVsbG8=", mimeType: "image/png" as const });

describe.skipIf(!DB_URL)("matching on real PostgreSQL + pgvector (disposable schema)", () => {
  let admin: Pool;
  let pool: Pool;
  let schema = "";
  let store: PgMatchStore;
  const provider = createMockProvider({
    classifications: {
      "forest.png": { category: "nature", tags: ["forest", "river", "trees"], confidence: 0.9 },
      "forest-unsure.png": { category: "nature", tags: ["forest", "river", "trees"], confidence: 0.3 },
    },
  });
  const ids = { articles: [] as string[] };

  const insertImage = async (path: string): Promise<string> => {
    const sha = createHash("sha256").update(randomBytes(16)).digest("hex");
    const r = await pool.query<{ id: string }>(
      "INSERT INTO images (sha256, mime_type, byte_size, storage_path) VALUES ($1, 'image/png', 10, $2) RETURNING id",
      [sha, path],
    );
    return r.rows[0]!.id;
  };
  const insertArticle = async (title: string, body: string, category: string, tags: string[]): Promise<string> => {
    const hash = createHash("sha256")
      .update(title + body)
      .digest("hex");
    const r = await pool.query<{ id: string }>(
      "INSERT INTO articles (title, body, category, tags, content_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [title, body, category, tags, hash],
    );
    return r.rows[0]!.id;
  };
  const prepareImage = async (path: string): Promise<string> => {
    const id = await insertImage(path);
    await ensureImageClassification({ store, provider, imageId: id, loadImage });
    await ensureImageEmbedding({ store, provider, imageId: id });
    return id;
  };
  const jobs = (imageId: string) =>
    pool
      .query(
        "SELECT id, article_id, status, decision, similarity, policy_version, embedding_model, guard_signals, decision_reasons FROM analysis_jobs WHERE image_id = $1 ORDER BY (guard_signals->>'rank')::int",
        [imageId],
      )
      .then((r) => r.rows);

  beforeAll(async () => {
    schema = `it_${randomBytes(6).toString("hex")}`;
    admin = new Pool({ connectionString: DB_URL, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: DB_URL, max: 10, options: `-c search_path=${schema},public` });
    const client = await pool.connect();
    try {
      await runMigrations(client, await loadMigrations(DIR));
    } finally {
      client.release();
    }
    store = new PgMatchStore(pool);
    ids.articles = [
      await insertArticle(
        "Forest river hike",
        "Forest river trees hiking trail along the river among tall trees and forest.",
        "nature",
        ["forest"],
      ),
      await insertArticle(
        "Mountain trees",
        "Mountain forest trees hiking trail summit views above the tree line.",
        "nature",
        ["forest"],
      ),
      await insertArticle(
        "Stock market wrap",
        "Stocks bonds inflation interest rates market quarterly earnings guidance.",
        "finance",
        ["stocks"],
      ),
    ];
    for (const id of ids.articles) await ensureArticleEmbedding({ store, provider, articleId: id });
  });

  afterAll(async () => {
    await pool?.end();
    if (/^it_[0-9a-f]{12}$/.test(schema)) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); // only our own temp schema
    await admin?.end();
  });

  it("all migrations apply; the 002 objects exist with the right types; re-running is a no-op", async () => {
    const tables = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = $1", [
      schema,
    ]);
    expect(tables.rows.map((r) => r.table_name)).toEqual(
      expect.arrayContaining([
        "article_embeddings",
        "image_classifications",
        "analysis_jobs",
        "image_embeddings",
        "reviews",
        "job_audit_events",
        "schema_migrations",
      ]),
    );
    const col = await pool.query(
      `SELECT format_type(a.atttypid, a.atttypmod) AS t FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 'article_embeddings' AND a.attname = 'embedding'`,
      [schema],
    );
    expect(col.rows[0]?.t).toBe("vector(768)");
    const idx = await pool.query(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'article_embeddings_embedding_hnsw'",
      [schema],
    );
    expect(idx.rows[0]?.indexdef).toMatch(/hnsw.*vector_cosine_ops/);
    const cols = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'analysis_jobs' AND column_name IN ('guard_signals','embedding_model')",
      [schema],
    );
    expect(cols.rowCount).toBe(2);
    const client = await pool.connect();
    try {
      expect((await runMigrations(client, await loadMigrations(DIR))).applied).toEqual([]);
    } finally {
      client.release();
    }
    const applied = await pool.query("SELECT version FROM schema_migrations ORDER BY version");
    // Derived from the migration files (not hard-coded) so adding a migration cannot silently break this test.
    const files = (await loadMigrations(DIR)).map((m) => m.version);
    expect(applied.rows.map((r) => r.version)).toEqual(files);
    expect(files.slice(0, 2)).toEqual([1, 2]);
  });

  it("end to end: prepare -> pgvector ranking -> guard -> persisted accepted AND rejected rows, audited", async () => {
    const imageId = await prepareImage("photos/forest.png");
    const r = await generateMatches({ store, imageId, embeddingModel: provider.embeddingModel, guardConfig: loose });
    expect(r.skipped).toBe(false);
    expect(r.outcomes).toEqual({ created: 3, updated: 0, preserved: 0 });

    const rows = await jobs(imageId);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.article_id).toBe(ids.articles[0]); // semantically closest article ranks first
    expect(rows[2]?.article_id).toBe(ids.articles[2]); // unrelated article last
    expect(rows[2]).toMatchObject({ decision: "reject", status: "completed" });
    expect(rows[0]).toMatchObject({
      decision: "accept",
      status: "completed",
      policy_version: "guard-v1",
      embedding_model: "mock-lexical-hash",
    });
    expect(rows[0]?.guard_signals).toMatchObject({ rank: 1, embeddingTaskType: EMBEDDING_TASK_TYPE });
    expect(rows[2]?.decision_reasons.map((x: { code: string }) => x.code)).toEqual(
      expect.arrayContaining(["BELOW_SIMILARITY_THRESHOLD", "CATEGORY_MISMATCH"]),
    );

    // pgvector cosine similarity == independent JS computation
    const imgVec = lexicalHashEmbed(
      buildImageEmbeddingText({ category: "nature", tags: ["forest", "river", "trees"] }),
    );
    const bodies = [
      buildArticleEmbeddingText({
        title: "Forest river hike",
        body: "Forest river trees hiking trail along the river among tall trees and forest.",
      }),
      buildArticleEmbeddingText({
        title: "Mountain trees",
        body: "Mountain forest trees hiking trail summit views above the tree line.",
      }),
      buildArticleEmbeddingText({
        title: "Stock market wrap",
        body: "Stocks bonds inflation interest rates market quarterly earnings guidance.",
      }),
    ];
    bodies.forEach((text, i) => {
      const row = rows.find((x) => x.article_id === ids.articles[i]);
      expect(Number(row?.similarity)).toBeCloseTo(cosineSimilarity(imgVec, lexicalHashEmbed(text)), 5);
    });

    const audit = await pool.query("SELECT event_type, actor FROM job_audit_events WHERE job_id = ANY($1)", [
      rows.map((x) => x.id),
    ]);
    expect(audit.rowCount).toBe(3);
    expect(audit.rows.every((a) => a.event_type === "guard_evaluated" && a.actor === "system:mismatch-guard")).toBe(
      true,
    );
  });

  it("a REVIEW decision is persisted as status needs_review", async () => {
    const imageId = await prepareImage("photos/forest-unsure.png");
    await generateMatches({ store, imageId, embeddingModel: provider.embeddingModel, guardConfig: loose });
    const [top] = await jobs(imageId);
    expect(top).toMatchObject({ decision: "review", status: "needs_review" });
    expect(top?.decision_reasons.map((x: { code: string }) => x.code)).toEqual(["LOW_CLASSIFICATION_CONFIDENCE"]);
  });

  it("is idempotent: second run skipped; forced run updates in place with no duplicates and extra audit events", async () => {
    const imageId = await prepareImage("photos/forest.png");
    await generateMatches({ store, imageId, embeddingModel: provider.embeddingModel, guardConfig: loose });
    const again = await generateMatches({
      store,
      imageId,
      embeddingModel: provider.embeddingModel,
      guardConfig: loose,
    });
    expect(again.skipped).toBe(true);
    const forced = await generateMatches({
      store,
      imageId,
      embeddingModel: provider.embeddingModel,
      guardConfig: loose,
      force: true,
    });
    expect(forced.outcomes).toEqual({ created: 0, updated: 3, preserved: 0 });
    expect(await jobs(imageId)).toHaveLength(3);
    const audit = await pool.query(
      "SELECT count(*)::int AS n FROM job_audit_events WHERE job_id IN (SELECT id FROM analysis_jobs WHERE image_id = $1)",
      [imageId],
    );
    expect(audit.rows[0]?.n).toBe(6);
  });

  it("a forced re-run NEVER overwrites a human-reviewed result, even under a policy that would flip it", async () => {
    const imageId = await prepareImage("photos/forest.png");
    await generateMatches({ store, imageId, embeddingModel: provider.embeddingModel, guardConfig: loose });
    const [top] = await jobs(imageId);
    await pool.query(
      "INSERT INTO reviews (job_id, reviewer, decision, notes) VALUES ($1, 'alice', 'approved', 'checked by hand')",
      [top!.id],
    );
    const auditBefore = await pool.query("SELECT count(*)::int AS n FROM job_audit_events WHERE job_id = $1", [
      top!.id,
    ]);

    const forced = await generateMatches({
      store,
      imageId,
      embeddingModel: provider.embeddingModel,
      guardConfig: strict,
      force: true,
    });
    expect(forced.outcomes).toEqual({ created: 0, updated: 2, preserved: 1 });
    const after = await jobs(imageId);
    expect(after[0]).toMatchObject({ id: top!.id, decision: "accept", status: "completed" }); // unchanged
    expect(after[1]?.decision).toBe("reject"); // unreviewed rows follow the new policy
    expect(forced.evaluations[0]).toMatchObject({ articleId: ids.articles[0], hasReview: true });
    const auditAfter = await pool.query("SELECT count(*)::int AS n FROM job_audit_events WHERE job_id = $1", [top!.id]);
    expect(auditAfter.rows[0]?.n).toBe(auditBefore.rows[0]?.n);
  });

  it("CONCURRENT review: a review that commits while the re-run waits on the row lock is seen and preserved", async () => {
    const imageId = await prepareImage("photos/forest.png");
    await generateMatches({ store, imageId, embeddingModel: provider.embeddingModel, guardConfig: loose });
    const [top] = await jobs(imageId);

    const reviewer = await pool.connect();
    try {
      await reviewer.query("BEGIN");
      await reviewer.query(
        "INSERT INTO reviews (job_id, reviewer, decision, notes) VALUES ($1, 'bob', 'rejected', 'in flight')",
        [top!.id],
      ); // holds a lock on the job row, uncommitted

      const run = generateMatches({
        store,
        imageId,
        embeddingModel: provider.embeddingModel,
        guardConfig: strict,
        force: true,
      });
      let sawLockWait = false;
      for (let i = 0; i < 60 && !sawLockWait; i += 1) {
        const w = await admin.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
        );
        sawLockWait = (w.rows[0]?.n ?? 0) > 0;
        if (!sawLockWait) await new Promise((r) => setTimeout(r, 50));
      }
      expect(sawLockWait).toBe(true); // proves the re-run really was blocked by the in-flight review
      await reviewer.query("COMMIT");

      const result = await run;
      expect(result.outcomes.preserved).toBe(1);
      const after = await jobs(imageId);
      expect(after[0]).toMatchObject({ id: top!.id, decision: "accept" }); // the reviewed row kept its decision
    } finally {
      await reviewer.query("ROLLBACK").catch(() => undefined); // no-op after COMMIT; prevents a leaked open transaction on failure
      reviewer.release();
    }
  });

  it("two simultaneous forced runs for the same image create no duplicates and do not deadlock", async () => {
    const imageId = await prepareImage("photos/forest.png");
    const go = () =>
      generateMatches({ store, imageId, embeddingModel: provider.embeddingModel, guardConfig: loose, force: true });
    const [a, b] = await Promise.all([go(), go()]);
    expect(a.outcomes.created + b.outcomes.created).toBe(3);
    expect(await jobs(imageId)).toHaveLength(3);
  });

  it("a failing record rolls back the WHOLE batch: nothing from the run is persisted", async () => {
    const imageId = await prepareImage("photos/forest.png");
    const base = (articleId: string, decision: string): EvaluationRecord => ({
      imageId,
      articleId,
      rank: 1,
      classification: { category: "nature", tags: ["forest"], confidence: 0.9, provider: "mock", model: "mock-vision" },
      space: { model: provider.embeddingModel, taskType: EMBEDDING_TASK_TYPE },
      similarity: 0.9,
      decision: decision as never,
      primaryReasonCode: null,
      reasons: [],
      signals: {
        confidence: 0.9,
        similarity: 0.9,
        rank: 1,
        margin: null,
        sharedTagCount: 1,
        imageCategory: "nature",
        articleCategory: "nature",
      },
      policyVersion: "guard-v1",
      policyConfig: loose,
    });
    const first = ids.articles[0]!;
    const second = ids.articles[1]!;
    const ordered = [first, second].sort(); // the store processes in articleId order; make the INVALID one come second
    await expect(store.saveEvaluations([base(ordered[0]!, "accept"), base(ordered[1]!, "bogus")])).rejects.toThrow(
      /check constraint|violates/i,
    );
    expect(await jobs(imageId)).toHaveLength(0);
    const audit = await pool.query(
      "SELECT count(*)::int AS n FROM job_audit_events WHERE job_id IN (SELECT id FROM analysis_jobs WHERE image_id = $1)",
      [imageId],
    );
    expect(audit.rows[0]?.n).toBe(0);
    // the connection was released cleanly and the store still works
    expect(
      (await generateMatches({ store, imageId, embeddingModel: provider.embeddingModel, guardConfig: loose })).outcomes
        .created,
    ).toBe(3);
  });

  it("never compares across embedding models or task types", async () => {
    // image embedded ONLY in another model
    const other = await insertImage("photos/other-model.png");
    await store.upsertImageEmbedding(other, lexicalHashEmbed("forest river"), {
      model: "model-x",
      taskType: EMBEDDING_TASK_TYPE,
    });
    await ensureImageClassification({ store, provider, imageId: other, loadImage }).catch(() => undefined);
    await store.upsertClassification(
      other,
      { category: "nature", tags: ["forest"], confidence: 0.9, provider: "mock", model: "mock-vision" },
      {},
    );
    await expect(
      generateMatches({ store, imageId: other, embeddingModel: provider.embeddingModel, guardConfig: loose }),
    ).rejects.toBeInstanceOf(IncompatibleEmbeddingModelError);
    // image in 'model-x', articles only in the mock model -> corpus incompatible, never compared
    const err = await generateMatches({ store, imageId: other, embeddingModel: "model-x", guardConfig: loose }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(IncompatibleEmbeddingModelError);
    expect((err as Error).message).toMatch(/article corpus/);
    // same model, different task type
    const task = await insertImage("photos/other-task.png");
    await store.upsertClassification(
      task,
      { category: "nature", tags: ["forest"], confidence: 0.9, provider: "mock", model: "mock-vision" },
      {},
    );
    await store.upsertImageEmbedding(task, lexicalHashEmbed("forest river"), {
      model: provider.embeddingModel,
      taskType: "RETRIEVAL_QUERY",
    });
    await expect(
      generateMatches({ store, imageId: task, embeddingModel: provider.embeddingModel, guardConfig: loose }),
    ).rejects.toBeInstanceOf(IncompatibleEmbeddingModelError);
    expect(await jobs(other)).toHaveLength(0);
    expect(await jobs(task)).toHaveLength(0);
  });

  it("a zero-vector embedding yields a NaN similarity that is stored as NULL and REJECTED (never accepted, never a constraint error)", async () => {
    const imageId = await insertImage("photos/zero.png");
    await store.upsertClassification(
      imageId,
      { category: "nature", tags: ["forest"], confidence: 0.9, provider: "mock", model: "mock-vision" },
      {},
    );
    await store.upsertImageEmbedding(imageId, new Array(768).fill(0), {
      model: provider.embeddingModel,
      taskType: EMBEDDING_TASK_TYPE,
    });
    await generateMatches({ store, imageId, embeddingModel: provider.embeddingModel, guardConfig: loose });
    const rows = await jobs(imageId);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.decision === "reject" && r.similarity === null)).toBe(true);
  });

  it("database contract: decision, status and policy columns stay consistent across all persisted rows", async () => {
    const bad = await pool.query(
      `SELECT count(*)::int AS n FROM analysis_jobs
       WHERE (decision = 'review') <> (status = 'needs_review') OR decision IS NULL OR policy_version IS NULL
          OR status NOT IN ('completed', 'needs_review')`,
    );
    expect(bad.rows[0]?.n).toBe(0);
  });
});
