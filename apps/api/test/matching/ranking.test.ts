import { describe, expect, it } from "vitest";
import {
  cosineSimilarity,
  evaluateCandidates,
  marginAt,
  rankCandidates,
  resolveGuardConfig,
  type Candidate,
} from "../../src/matching/index.js";

const c = (
  articleId: string,
  similarity: number,
  category: string | null = "nature",
  tags: string[] = ["river"],
): Candidate => ({ articleId, similarity, category, tags });
const cls = { category: "nature", tags: ["river"], confidence: 0.9 };
const cfg = resolveGuardConfig();

describe("cosineSimilarity", () => {
  it("is 1 for identical direction, 0 for orthogonal, -1 for opposite, scale-invariant", () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 12);
    expect(cosineSimilarity([1, 0], [-3, 0])).toBeCloseTo(-1, 12);
  });
  it("returns NaN for a zero vector and throws on length mismatch", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBeNaN();
    expect(() => cosineSimilarity([1], [1, 2])).toThrow(RangeError);
  });
});

describe("rankCandidates", () => {
  it("sorts best first without mutating the input", () => {
    const input = [c("a", 0.2), c("b", 0.9), c("c", 0.5)];
    const copy = [...input];
    expect(rankCandidates(input).map((x) => x.articleId)).toEqual(["b", "c", "a"]);
    expect(input).toEqual(copy);
  });
  it("breaks ties deterministically by articleId", () => {
    expect(rankCandidates([c("z", 0.5), c("a", 0.5), c("m", 0.5)]).map((x) => x.articleId)).toEqual(["a", "m", "z"]);
    expect(rankCandidates([c("m", 0.5), c("z", 0.5), c("a", 0.5)]).map((x) => x.articleId)).toEqual(["a", "m", "z"]);
  });
  it("sorts NaN similarities last", () => {
    expect(rankCandidates([c("a", NaN), c("b", 0.1), c("c", -0.5)]).map((x) => x.articleId)).toEqual(["b", "c", "a"]);
  });
});

describe("marginAt", () => {
  const sorted = [c("a", 0.9), c("b", 0.7), c("c", 0.65)];
  it("is the gap to the next candidate", () => {
    expect(marginAt(sorted, 0)).toBeCloseTo(0.2, 12);
    expect(marginAt(sorted, 1)).toBeCloseTo(0.05, 12);
  });
  it("is null for the last candidate, an empty list, or an out-of-range index", () => {
    expect(marginAt(sorted, 2)).toBeNull();
    expect(marginAt([], 0)).toBeNull();
    expect(marginAt(sorted, 9)).toBeNull();
  });
});

describe("evaluateCandidates", () => {
  it("runs EVERY candidate through the guard, accepted and rejected alike", () => {
    const out = evaluateCandidates(cls, [c("a", 0.9), c("b", 0.7), c("c", 0.2)], cfg, 3);
    expect(out.map((e) => [e.candidate.articleId, e.rank, e.result.decision])).toEqual([
      ["a", 1, "accept"],
      ["b", 2, "accept"],
      ["c", 3, "reject"],
    ]);
  });
  it("flags a near-tie for the TOP slot only and reports the margin", () => {
    const out = evaluateCandidates(cls, [c("a", 0.8), c("b", 0.79), c("c", 0.2)], cfg, 3);
    expect(out[0]?.result.reasons.map((r) => r.code)).toEqual(["AMBIGUOUS_MATCH"]);
    expect(out[0]?.result.decision).toBe("review");
    expect(out[0]?.margin).toBeCloseTo(0.01, 12);
    expect(out[1]?.result.reasons.map((r) => r.code)).not.toContain("AMBIGUOUS_MATCH");
  });
  it("a lone candidate has no runner-up, so no ambiguity", () => {
    const [only] = evaluateCandidates(cls, [c("a", 0.8)], cfg, 3);
    expect(only?.nextSimilarity).toBeNull();
    expect(only?.result.decision).toBe("accept");
  });
  it("keeps only topK candidates and ranks them 1..k", () => {
    const out = evaluateCandidates(cls, [c("a", 0.9), c("b", 0.8), c("c", 0.7), c("d", 0.65)], cfg, 2);
    expect(out.map((e) => e.rank)).toEqual([1, 2]);
    expect(out.map((e) => e.candidate.articleId)).toEqual(["a", "b"]);
  });
  it("a NaN-similarity candidate is rejected, never accepted, and cannot displace valid ones", () => {
    const out = evaluateCandidates(cls, [c("a", NaN), c("b", 0.9)], cfg, 2);
    expect(out[0]?.candidate.articleId).toBe("b");
    expect(out[1]?.result.decision).toBe("reject");
  });
  it("category mismatch candidates are rejected even with high similarity", () => {
    const [only] = evaluateCandidates(cls, [c("a", 0.95, "finance", ["stocks"])], cfg, 1);
    expect(only?.result.decision).toBe("reject");
    expect(only?.result.primaryReasonCode).toBe("CATEGORY_MISMATCH");
  });
  it("is deterministic for equal inputs", () => {
    const input = [c("b", 0.5), c("a", 0.5)];
    expect(evaluateCandidates(cls, input, cfg, 2)).toEqual(evaluateCandidates(cls, [...input].reverse(), cfg, 2));
  });
});
