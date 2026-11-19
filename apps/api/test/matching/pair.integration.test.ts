import { randomBytes, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockProvider } from "../../src/ai/index.js";
import { loadMigrations, runMigrations } from "../../src/db/migrate.js";
import {
  PgMatchStore,
  ensureArticleEmbedding,
  ensureImageClassification,
  ensureImageEmbedding,
  evaluatePair,
  generateMatches,
  resolveGuardConfig,
} from "../../src/matching/index.js";

/** REAL PostgreSQL + pgvector in a disposable schema. Skipped unless TEST_DATABASE_URL is set. */
const DB_URL = process.env.TEST_DATABASE_URL;
const DIR = fileURLToPath(new URL("../../migrations", import.meta.url));
const loose = resolveGuardConfig({ minSimilarity: 0.1, minMargin: 0 });
const loadImage = async () => ({ base64: "aGVsbG8=", mimeType: "image/png" as const });

describe.skipIf(!DB_URL)("evaluatePair on real pgvector", () => {
  let admin: Pool;
  let pool: Pool;
  let schema = "";
  let store: PgMatchStore;
  const provider = createMockProvider({
    classifications: { "forest.png": { category: "nature", tags: ["forest", "river", "trees"], confidence: 0.9 } },
  });
  const articleIds: string[] = [];
  let imageId = "";

  beforeAll(async () => {
    schema = `it_${randomBytes(6).toString("hex")}`;
    admin = new Pool({ connectionString: DB_URL, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: DB_URL, max: 5, options: `-c search_path=${schema},public` });
    const c = await pool.connect();
    try {
      await runMigrations(c, await loadMigrations(DIR));
    } finally {
      c.release();
    }
    store = new PgMatchStore(pool);
    const articles: Array<[string, string, string, string[]]> = [
      [
        "Forest river hike",
        "Forest river trees hiking trail along the river among tall trees and forest.",
        "nature",
        ["forest"],
      ],
      ["Mountain trees", "Mountain forest trees hiking trail summit views above the tree line.", "nature", ["forest"]],
      ["River kayaking", "Kayaking down the river past forest banks and old trees.", "nature", ["river"]],
      [
        "Stock market wrap",
        "Stocks bonds inflation interest rates market quarterly earnings guidance.",
        "finance",
        ["stocks"],
      ],
      [
        "Football final",
        "The striker scored twice as the home side lifted the cup on penalties.",
        "sports",
        ["football"],
      ],
    ];
    for (const [title, body, category, tags] of articles) {
      const r = await pool.query<{ id: string }>(
        "INSERT INTO articles (title, body, category, tags, content_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [
          title,
          body,
          category,
          tags,
          createHash("sha256")
            .update(title + body)
            .digest("hex"),
        ],
      );
      articleIds.push(r.rows[0]!.id);
      await ensureArticleEmbedding({ store, provider, articleId: r.rows[0]!.id });
    }
    const img = await pool.query<{ id: string }>(
      "INSERT INTO images (sha256, mime_type, byte_size, storage_path) VALUES ($1,'image/png',1,'forest.png') RETURNING id",
      [createHash("sha256").update(randomBytes(8)).digest("hex")],
    );
    imageId = img.rows[0]!.id;
    await ensureImageClassification({ store, provider, imageId, loadImage });
    await ensureImageEmbedding({ store, provider, imageId });
  });
  afterAll(async () => {
    await pool?.end();
    if (/^it_[0-9a-f]{12}$/.test(schema)) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  const space = { model: "mock-lexical-hash", taskType: "SEMANTIC_SIMILARITY" };

  it("pair rank, similarity, decision and reasons equal the M4 top-K path for EVERY article (SQL == JS ranking)", async () => {
    const all = await generateMatches({ store, imageId, embeddingModel: space.model, topK: 50, guardConfig: loose });
    expect(all.evaluations).toHaveLength(5);
    for (const e of all.evaluations) {
      const p = await evaluatePair({ store, imageId, articleId: e.articleId, space, guardConfig: loose });
      expect(p.rank, e.articleId).toBe(e.rank);
      expect(p.similarity, e.articleId).toBeCloseTo(e.similarity ?? NaN, 6);
      expect(p.result.decision, e.articleId).toBe(e.decision);
      expect(
        p.result.reasons.map((r) => r.code),
        e.articleId,
      ).toEqual(e.reasons.map((r) => r.code));
    }
  });

  it("evaluates a target that is NOT in the top-1 (rank > 1) exactly", async () => {
    const top1 = await store.findNearestArticles(imageId, space, 1); // the ONLY candidate a top-1 ranking would consider
    expect(top1).toHaveLength(1);
    const outside = articleIds.find((id) => id !== top1[0]!.articleId)!;
    const p = await evaluatePair({ store, imageId, articleId: outside, space, guardConfig: loose });
    expect(p.rank).toBeGreaterThan(1);
    expect(p.similarity).toBeLessThanOrEqual(top1[0]!.similarity);
  });

  it("returns null context for an article without an embedding in the space, and is read-only", async () => {
    const lone = await pool.query<{ id: string }>(
      "INSERT INTO articles (title, body, content_hash) VALUES ('x','y',$1) RETURNING id",
      [randomBytes(32).toString("hex")],
    );
    expect(await store.getPairContext(imageId, lone.rows[0]!.id, space)).toBeNull();
    const before = (await pool.query("SELECT count(*)::int AS n FROM analysis_jobs")).rows[0]?.n;
    await evaluatePair({ store, imageId, articleId: articleIds[0]!, space, guardConfig: loose });
    expect((await pool.query("SELECT count(*)::int AS n FROM analysis_jobs")).rows[0]?.n).toBe(before);
  });

  it("a zero-vector image gives NaN similarity: rejected, and the SQL rank logic does not break", async () => {
    const img = await pool.query<{ id: string }>(
      "INSERT INTO images (sha256, mime_type, byte_size, storage_path) VALUES ($1,'image/png',1,'zero.png') RETURNING id",
      [createHash("sha256").update(randomBytes(8)).digest("hex")],
    );
    await store.upsertClassification(
      img.rows[0]!.id,
      { category: "nature", tags: ["forest"], confidence: 0.9, provider: "mock", model: "mock-vision" },
      {},
    );
    await store.upsertImageEmbedding(img.rows[0]!.id, new Array(768).fill(0), space);
    const p = await evaluatePair({
      store,
      imageId: img.rows[0]!.id,
      articleId: articleIds[0]!,
      space,
      guardConfig: loose,
    });
    expect(Number.isNaN(p.similarity)).toBe(true);
    expect(p.result.decision).toBe("reject");
  });
});
