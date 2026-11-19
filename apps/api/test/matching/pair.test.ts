import { describe, expect, it } from "vitest";
import {
  ArticleNotFoundError,
  ImageNotFoundError,
  IncompatibleEmbeddingModelError,
  MissingPrerequisiteError,
  evaluatePair,
  generateMatches,
  resolveGuardConfig,
  type EmbeddingSpace,
} from "../../src/matching/index.js";
import { FakeStore, vec } from "./fakeStore.js";

const SPACE: EmbeddingSpace = { model: "m1", taskType: "SEMANTIC_SIMILARITY" };
const CLS = { category: "nature", tags: ["forest"], confidence: 0.9, provider: "mock", model: "mock-vision" };
const loose = resolveGuardConfig({ minSimilarity: 0.2, minMargin: 0.02 });

/** image on axis 0. a1 very close, a2 medium, a3 far, a4 far-ish. */
function seeded(): FakeStore {
  const s = new FakeStore();
  s.addImage("i1");
  s.classifications.set("i1", [CLS]);
  s.imageVectors.set("i1", [{ space: SPACE, vector: vec(0) }]);
  for (const [id, cat, tags] of [
    ["a1", "nature", ["forest"]],
    ["a2", "nature", ["forest"]],
    ["a3", "finance", ["stocks"]],
    ["a4", "nature", ["forest"]],
  ] as const)
    s.addArticle(id, cat, [...tags]);
  s.articleVectors.set("a1", [{ space: SPACE, vector: vec(0, 1, 0.1) }]); // ~0.995
  s.articleVectors.set("a2", [{ space: SPACE, vector: vec(0, 1, 1.2) }]); // ~0.64
  s.articleVectors.set("a3", [{ space: SPACE, vector: vec(5) }]); // 0
  s.articleVectors.set("a4", [{ space: SPACE, vector: vec(0, 1, 3) }]); // ~0.32
  return s;
}
const pair = (s: FakeStore, articleId: string, over: Partial<Parameters<typeof evaluatePair>[0]> = {}) =>
  evaluatePair({ store: s, imageId: "i1", articleId, space: SPACE, guardConfig: loose, ...over });

describe("evaluatePair: the target article need not be in the top-K", () => {
  it("evaluates a low-ranked article exactly (rank 4 of 4), which top-1 ranking would never have produced", async () => {
    const s = seeded();
    const top1 = await generateMatches({
      store: s,
      imageId: "i1",
      embeddingModel: SPACE.model,
      topK: 1,
      guardConfig: loose,
    });
    expect(top1.evaluations.map((e) => e.articleId)).toEqual(["a1"]); // a3 is absent from top-K...
    const p = await pair(s, "a3"); // ...but its pair evaluation is exact
    expect(p.rank).toBe(4);
    expect(p.similarity).toBeCloseTo(0, 10);
    expect(p.result.decision).toBe("reject");
    expect(p.result.reasons.map((r) => r.code)).toEqual(
      expect.arrayContaining(["BELOW_SIMILARITY_THRESHOLD", "CATEGORY_MISMATCH"]),
    );
  });

  it("rank 1 with a clear margin is accepted; the runner-up is the best OTHER article", async () => {
    const p = await pair(seeded(), "a1");
    expect(p).toMatchObject({ rank: 1 });
    expect(p.nextSimilarity).toBeCloseTo(0.64, 1);
    expect(p.result).toMatchObject({ decision: "accept", primaryReasonCode: null });
    expect(p.result.signals.margin).toBeGreaterThan(0.3);
  });

  it("rank 1 with a near-tie runner-up -> AMBIGUOUS_MATCH -> review", async () => {
    const s = seeded();
    s.articleVectors.set("a2", [{ space: SPACE, vector: vec(0, 1, 0.1005) }]); // practically identical to a1
    const p = await pair(s, "a1");
    expect(p.rank).toBeLessThanOrEqual(2);
    const top = p.rank === 1 ? p : await pair(s, "a2");
    expect(top.result.reasons.map((r) => r.code)).toEqual(["AMBIGUOUS_MATCH"]);
    expect(top.result.decision).toBe("review");
  });

  it("a rank > 1 article is never flagged ambiguous and gets no margin", async () => {
    const p = await pair(seeded(), "a2");
    expect(p.rank).toBe(2);
    expect(p.nextSimilarity).toBeNull();
    expect(p.result.signals.margin).toBeNull();
    expect(p.result.reasons.map((r) => r.code)).not.toContain("AMBIGUOUS_MATCH");
  });

  it("a lone article has rank 1, no runner-up, and is not ambiguous", async () => {
    const s = seeded();
    for (const id of ["a2", "a3", "a4"]) s.articleVectors.delete(id);
    const p = await pair(s, "a1");
    expect(p).toMatchObject({ rank: 1, nextSimilarity: null });
    expect(p.result.decision).toBe("accept");
  });

  it("ties are broken by article id, the same order the top-K ranking uses", async () => {
    const s = seeded();
    s.articleVectors.set("a1", [{ space: SPACE, vector: vec(0, 1, 1) }]);
    s.articleVectors.set("a2", [{ space: SPACE, vector: vec(0, 1, 1) }]);
    expect((await pair(s, "a1")).rank).toBe(1);
    expect((await pair(s, "a2")).rank).toBe(2);
  });

  it("an article with a degenerate (zero) vector has NaN similarity: it is rejected, ranked last, and never anyone's runner-up", async () => {
    const s = seeded();
    s.articleVectors.set("a3", [{ space: SPACE, vector: new Array(768).fill(0) }]);
    const bad = await pair(s, "a3");
    expect(Number.isNaN(bad.similarity)).toBe(true);
    expect(bad.rank).toBe(4);
    expect(bad.result.decision).toBe("reject");
    expect(bad.result.reasons.map((r) => r.code)).toContain("BELOW_SIMILARITY_THRESHOLD");
    const good = await pair(s, "a1");
    expect(Number.isNaN(good.nextSimilarity ?? 0)).toBe(false); // NaN is not picked as the runner-up
  });

  it("uses the guard configuration unchanged: a stricter policy flips the same pair", async () => {
    const s = seeded();
    expect((await pair(s, "a2")).result.decision).toBe("accept");
    expect(
      (await pair(s, "a2", { guardConfig: resolveGuardConfig({ minSimilarity: 0.9, minMargin: 0 }) })).result.decision,
    ).toBe("reject");
  });
});

describe("evaluatePair agrees with the M4 top-K path for every article", () => {
  it("same rank, similarity, decision and reason codes for all articles", async () => {
    const s = seeded();
    const all = await generateMatches({
      store: s,
      imageId: "i1",
      embeddingModel: SPACE.model,
      topK: 50,
      guardConfig: loose,
    });
    expect(all.evaluations).toHaveLength(4);
    for (const e of all.evaluations) {
      const p = await pair(s, e.articleId);
      expect(p.rank, e.articleId).toBe(e.rank);
      expect(p.similarity, e.articleId).toBeCloseTo(e.similarity ?? NaN, 10);
      expect(p.result.decision, e.articleId).toBe(e.decision);
      expect(
        p.result.reasons.map((r) => r.code),
        e.articleId,
      ).toEqual(e.reasons.map((r) => r.code));
    }
  });
});

describe("evaluatePair: missing prerequisites and incompatible embeddings", () => {
  it("unknown image / article", async () => {
    await expect(pair(seeded(), "a1", { imageId: "nope" })).rejects.toBeInstanceOf(ImageNotFoundError);
    await expect(pair(seeded(), "nope")).rejects.toBeInstanceOf(ArticleNotFoundError);
  });
  it("no classification / no image embedding / no article embedding", async () => {
    const a = seeded();
    a.classifications.clear();
    await expect(pair(a, "a1")).rejects.toMatchObject({ code: "missing_prerequisite", what: "classification" });
    const b = seeded();
    b.imageVectors.clear();
    await expect(pair(b, "a1")).rejects.toMatchObject({ what: "image embedding" });
    const c = seeded();
    c.articleVectors.delete("a1");
    await expect(pair(c, "a1")).rejects.toBeInstanceOf(MissingPrerequisiteError);
    await expect(pair(c, "a1")).rejects.toMatchObject({ what: "article embeddings" });
  });
  it("model or task-type mismatch is refused, never compared", async () => {
    const a = seeded();
    a.imageVectors.set("i1", [{ space: { model: "other", taskType: SPACE.taskType }, vector: vec(0) }]);
    await expect(pair(a, "a1")).rejects.toBeInstanceOf(IncompatibleEmbeddingModelError);
    const b = seeded();
    b.articleVectors.set("a1", [{ space: { model: SPACE.model, taskType: "RETRIEVAL_DOCUMENT" }, vector: vec(0) }]);
    await expect(pair(b, "a1")).rejects.toBeInstanceOf(IncompatibleEmbeddingModelError);
  });
  it("persists nothing (it is a pure read + guard)", async () => {
    const s = seeded();
    await pair(s, "a1");
    expect(s.rows.size).toBe(0);
  });
});
