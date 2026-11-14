import { describe, expect, it } from "vitest";
import {
  IncompatibleEmbeddingModelError,
  ImageNotFoundError,
  MissingPrerequisiteError,
  generateMatches,
  resolveGuardConfig,
  suggestionKey,
  type EmbeddingSpace,
} from "../../src/matching/index.js";
import { FakeStore, vec } from "./fakeStore.js";

const SPACE: EmbeddingSpace = { model: "m1", taskType: "SEMANTIC_SIMILARITY" };
const CLS = { category: "nature", tags: ["forest"], confidence: 0.9, provider: "mock", model: "mock-vision" };

/** image i1 (axis 0). Articles: close (a1), medium (a2), far (a3). */
function seeded(): FakeStore {
  const s = new FakeStore();
  s.addImage("i1", "sports/football.png"); // deliberately misleading name: it must be ignored
  s.classifications.set("i1", [CLS]);
  s.imageVectors.set("i1", [{ space: SPACE, vector: vec(0) }]);
  s.addArticle("a1", "nature", ["forest"]);
  s.addArticle("a2", "nature", ["forest"]);
  s.addArticle("a3", "finance", ["stocks"]);
  s.articleVectors.set("a1", [{ space: SPACE, vector: vec(0, 1, 0.1) }]); // sim ≈ 0.995
  s.articleVectors.set("a2", [{ space: SPACE, vector: vec(0, 1, 1.2) }]); // sim ≈ 0.64
  s.articleVectors.set("a3", [{ space: SPACE, vector: vec(5) }]); // sim 0
  return s;
}
const run = (s: FakeStore, over: Partial<Parameters<typeof generateMatches>[0]> = {}) =>
  generateMatches({ store: s, imageId: "i1", embeddingModel: SPACE.model, ...over });

describe("generateMatches: happy path", () => {
  it("ranks by embedding similarity (not filename) and persists accepted AND rejected candidates", async () => {
    const s = seeded();
    const r = await run(s);
    expect(r.skipped).toBe(false);
    expect(r.outcomes).toEqual({ created: 3, updated: 0, preserved: 0 });
    expect(r.evaluations.map((e) => [e.articleId, e.rank, e.decision])).toEqual([
      ["a1", 1, "accept"],
      ["a2", 2, "accept"],
      ["a3", 3, "reject"],
    ]);
    const rejected = r.evaluations.find((e) => e.articleId === "a3");
    expect(rejected?.reasons.map((x) => x.code)).toEqual(
      expect.arrayContaining(["BELOW_SIMILARITY_THRESHOLD", "CATEGORY_MISMATCH"]),
    );
    expect(r.evaluations[0]?.similarity).toBeGreaterThan(0.99);
  });
  it("persists the policy version, thresholds, signals and embedding space with each record", async () => {
    const s = seeded();
    await run(s);
    const rec = s.rows.get(suggestionKey("i1", "a1"))?.rec;
    expect(rec).toMatchObject({ policyVersion: "guard-v1", space: SPACE, rank: 1, decision: "accept" });
    expect(rec?.policyConfig).toEqual(resolveGuardConfig());
    expect(rec?.signals.sharedTagCount).toBe(1);
  });
  it("makes no AI call (store-only) and only compares same-space vectors", async () => {
    const s = seeded();
    s.articleVectors.set("a4", [{ space: { model: "other", taskType: SPACE.taskType }, vector: vec(0) }]); // perfect but wrong model
    s.addArticle("a4", "nature", ["forest"]);
    const r = await run(s);
    expect(r.evaluations.map((e) => e.articleId)).not.toContain("a4");
  });
  it("respects topK", async () => {
    const r = await run(seeded(), { topK: 2 });
    expect(r.evaluations).toHaveLength(2);
  });
  it.each([0, 51, 1.5, NaN])("rejects invalid topK %s", async (topK) => {
    await expect(run(seeded(), { topK })).rejects.toThrow(RangeError);
  });
  it("returns an empty result (no error) when the corpus is compatible but yields no candidates", async () => {
    const s = seeded();
    s.articleVectors.clear();
    s.articleVectors.set("zzz", [{ space: SPACE, vector: vec(0) }]); // embedded, but no article row -> no candidate
    const r = await run(s);
    expect(r.evaluations).toEqual([]);
  });
});

describe("generateMatches: missing prerequisites and incompatible models", () => {
  it("unknown image -> ImageNotFoundError", async () => {
    await expect(run(new FakeStore(), { imageId: "nope" })).rejects.toBeInstanceOf(ImageNotFoundError);
  });
  it("no classification -> MissingPrerequisiteError(classification)", async () => {
    const s = seeded();
    s.classifications.clear();
    await expect(run(s)).rejects.toMatchObject({ code: "missing_prerequisite", what: "classification" });
  });
  it("no image embedding -> MissingPrerequisiteError(image embedding)", async () => {
    const s = seeded();
    s.imageVectors.clear();
    await expect(run(s)).rejects.toMatchObject({ code: "missing_prerequisite", what: "image embedding" });
  });
  it("no article embeddings -> MissingPrerequisiteError(article embeddings)", async () => {
    const s = seeded();
    s.articleVectors.clear();
    await expect(run(s)).rejects.toMatchObject({ code: "missing_prerequisite", what: "article embeddings" });
  });
  it("image embedded with a different MODEL -> IncompatibleEmbeddingModelError, nothing persisted", async () => {
    const s = seeded();
    s.imageVectors.set("i1", [{ space: { model: "other", taskType: SPACE.taskType }, vector: vec(0) }]);
    const err = await run(s).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IncompatibleEmbeddingModelError);
    expect((err as IncompatibleEmbeddingModelError).message).toMatch(/other/);
    expect(s.rows.size).toBe(0);
  });
  it("image embedded with a different TASK TYPE -> IncompatibleEmbeddingModelError", async () => {
    const s = seeded();
    s.imageVectors.set("i1", [{ space: { model: SPACE.model, taskType: "RETRIEVAL_QUERY" }, vector: vec(0) }]);
    await expect(run(s)).rejects.toBeInstanceOf(IncompatibleEmbeddingModelError);
  });
  it("articles embedded only with another model -> IncompatibleEmbeddingModelError (never compared)", async () => {
    const s = seeded();
    for (const id of ["a1", "a2", "a3"])
      s.articleVectors.set(id, [{ space: { model: "other", taskType: SPACE.taskType }, vector: vec(0) }]);
    await expect(run(s)).rejects.toBeInstanceOf(IncompatibleEmbeddingModelError);
    expect(s.rows.size).toBe(0);
  });
  it("errors are permanent (retryable=false) and typed", async () => {
    const s = seeded();
    s.classifications.clear();
    const err = (await run(s).catch((e: unknown) => e)) as MissingPrerequisiteError;
    expect(err.retryable).toBe(false);
    expect(err.name).toBe("MissingPrerequisiteError");
  });
});

describe("generateMatches: idempotency and human reviews", () => {
  it("a second run is skipped and creates no duplicates", async () => {
    const s = seeded();
    await run(s);
    const again = await run(s);
    expect(again.skipped).toBe(true);
    expect(again.outcomes).toEqual({ created: 0, updated: 0, preserved: 0 });
    expect(s.rows.size).toBe(3);
  });
  it("force re-evaluates unreviewed rows in place (no duplicates)", async () => {
    const s = seeded();
    await run(s);
    const forced = await run(s, { force: true });
    expect(forced.outcomes).toEqual({ created: 0, updated: 3, preserved: 0 });
    expect(s.rows.size).toBe(3);
  });
  it("force NEVER overwrites a human-reviewed result, even when the new policy would flip it", async () => {
    const s = seeded();
    await run(s);
    const before = structuredClone(s.rows.get(suggestionKey("i1", "a1"))?.rec);
    s.review("i1", "a1");
    const strict = resolveGuardConfig({ minSimilarity: 1 }); // would reject everything
    const forced = await run(s, { force: true, guardConfig: strict });
    expect(forced.outcomes).toEqual({ created: 0, updated: 2, preserved: 1 });
    expect(s.rows.get(suggestionKey("i1", "a1"))?.rec).toEqual(before);
    expect(forced.evaluations.find((e) => e.articleId === "a1")).toMatchObject({ decision: "accept", hasReview: true });
    expect(forced.evaluations.find((e) => e.articleId === "a2")?.decision).toBe("reject");
  });
});

describe("generateMatches: atomicity", () => {
  it("a failure while saving the 2nd candidate persists NOTHING from the run", async () => {
    const s = seeded();
    s.failAtRecord = 1;
    await expect(run(s)).rejects.toThrow(/simulated database failure/);
    expect(s.rows.size).toBe(0);
    s.failAtRecord = null;
    const retry = await run(s); // a clean retry works and is not "skipped"
    expect(retry.skipped).toBe(false);
    expect(retry.outcomes.created).toBe(3);
  });
  it("a failure during a forced re-run leaves earlier results exactly as they were", async () => {
    const s = seeded();
    await run(s);
    const before = structuredClone([...s.rows.entries()]);
    s.failAtRecord = 2;
    await expect(run(s, { force: true, guardConfig: resolveGuardConfig({ minSimilarity: 1 }) })).rejects.toThrow();
    expect([...s.rows.entries()]).toEqual(before);
  });
});
