import { describe, expect, it } from "vitest";
import { GUARD_DEFAULTS, POLICY_VERSION, REASON_CODES } from "@iam/shared";
import {
  GuardInputError,
  MatchingError,
  REASON_SEVERITY,
  evaluateMatch,
  guardConfigFromEnv,
  normalizeLabel,
  normalizeLabels,
  resolveGuardConfig,
  type GuardInput,
} from "../../src/matching/index.js";
import { loadEnv } from "../../src/env.js";

const cfg = resolveGuardConfig(); // 0.5 / 0.6 / 0.02 / 1
const ok = (over: Partial<GuardInput> = {}): GuardInput => ({
  classification: { category: "nature", tags: ["tree", "river"], confidence: 0.9 },
  article: { category: "nature", tags: ["river"] },
  similarity: 0.8,
  rank: 1,
  nextSimilarity: 0.5,
  ...over,
});
const codes = (i: GuardInput, c = cfg) => evaluateMatch(i, c).reasons.map((r) => r.code);

describe("reason codes are preserved", () => {
  it("shared constants match the documented codes", () => {
    expect(Object.values(REASON_CODES).sort()).toEqual([
      "AMBIGUOUS_MATCH",
      "BELOW_SIMILARITY_THRESHOLD",
      "CATEGORY_MISMATCH",
      "LOW_CLASSIFICATION_CONFIDENCE",
    ]);
  });
});

describe("accept path", () => {
  it("accepts a confident, close, category-compatible, unambiguous match", () => {
    const r = evaluateMatch(ok());
    expect(r).toMatchObject({
      decision: "accept",
      primaryReasonCode: null,
      reasons: [],
      policyVersion: POLICY_VERSION,
    });
    expect(r.signals).toMatchObject({ confidence: 0.9, similarity: 0.8, rank: 1, sharedTagCount: 1 });
    expect(r.signals.margin).toBeCloseTo(0.3, 10);
  });
});

describe("each reason on its own", () => {
  it("LOW_CLASSIFICATION_CONFIDENCE -> review", () => {
    const r = evaluateMatch(ok({ classification: { category: "nature", tags: ["river"], confidence: 0.3 } }));
    expect(r.reasons.map((x) => x.code)).toEqual(["LOW_CLASSIFICATION_CONFIDENCE"]);
    expect(r).toMatchObject({ decision: "review", primaryReasonCode: "LOW_CLASSIFICATION_CONFIDENCE" });
    expect(r.reasons[0]?.explanation).toMatch(/0\.30.*0\.50/);
  });
  it("BELOW_SIMILARITY_THRESHOLD -> reject", () => {
    const r = evaluateMatch(ok({ similarity: 0.4, nextSimilarity: null }));
    expect(r.reasons.map((x) => x.code)).toEqual(["BELOW_SIMILARITY_THRESHOLD"]);
    expect(r).toMatchObject({ decision: "reject", primaryReasonCode: "BELOW_SIMILARITY_THRESHOLD" });
  });
  it("CATEGORY_MISMATCH -> reject (different categories, no shared tags)", () => {
    const r = evaluateMatch(ok({ article: { category: "finance", tags: ["stocks"] } }));
    expect(r.reasons.map((x) => x.code)).toEqual(["CATEGORY_MISMATCH"]);
    expect(r.decision).toBe("reject");
    expect(r.reasons[0]?.signals).toMatchObject({
      imageCategory: "nature",
      articleCategory: "finance",
      sharedTagCount: 0,
    });
  });
  it("CATEGORY_MISMATCH is tolerated when enough tags are shared", () => {
    expect(codes(ok({ article: { category: "travel", tags: ["River"] } }))).toEqual([]);
  });
  it("AMBIGUOUS_MATCH -> review (near tie with the runner-up)", () => {
    const r = evaluateMatch(ok({ similarity: 0.8, nextSimilarity: 0.79 }));
    expect(r.reasons.map((x) => x.code)).toEqual(["AMBIGUOUS_MATCH"]);
    expect(r).toMatchObject({ decision: "review", primaryReasonCode: "AMBIGUOUS_MATCH" });
  });
  it("severity table is as documented", () => {
    expect(REASON_SEVERITY).toEqual({
      LOW_CLASSIFICATION_CONFIDENCE: "review",
      BELOW_SIMILARITY_THRESHOLD: "reject",
      CATEGORY_MISMATCH: "reject",
      AMBIGUOUS_MATCH: "review",
    });
  });
});

describe("combinations: every failing rule is reported, in priority order", () => {
  it("all four at once -> reject, primary is the first REJECT-severity reason", () => {
    const r = evaluateMatch({
      classification: { category: "nature", tags: [], confidence: 0.1 },
      article: { category: "finance", tags: [] },
      similarity: 0.3,
      rank: 1,
      nextSimilarity: 0.3,
    });
    expect(r.reasons.map((x) => x.code)).toEqual([
      "LOW_CLASSIFICATION_CONFIDENCE",
      "BELOW_SIMILARITY_THRESHOLD",
      "CATEGORY_MISMATCH",
      "AMBIGUOUS_MATCH",
    ]);
    expect(r.decision).toBe("reject");
    expect(r.primaryReasonCode).toBe("BELOW_SIMILARITY_THRESHOLD");
  });
  it("only soft reasons together -> review, primary is the first soft reason", () => {
    const r = evaluateMatch(
      ok({ classification: { category: "nature", tags: ["river"], confidence: 0.2 }, nextSimilarity: 0.8 }),
    );
    expect(r.reasons.map((x) => x.code)).toEqual(["LOW_CLASSIFICATION_CONFIDENCE", "AMBIGUOUS_MATCH"]);
    expect(r).toMatchObject({ decision: "review", primaryReasonCode: "LOW_CLASSIFICATION_CONFIDENCE" });
  });
  it("low confidence + low similarity -> reject", () => {
    expect(
      evaluateMatch(
        ok({
          classification: { category: "nature", tags: ["river"], confidence: 0.2 },
          similarity: 0.1,
          nextSimilarity: null,
        }),
      ).decision,
    ).toBe("reject");
  });
});

describe("exact threshold boundaries (values AT the threshold pass)", () => {
  it("confidence == minConfidence passes; just below fails", () => {
    expect(codes(ok({ classification: { category: "nature", tags: ["river"], confidence: 0.5 } }))).toEqual([]);
    expect(codes(ok({ classification: { category: "nature", tags: ["river"], confidence: 0.4999999 } }))).toContain(
      "LOW_CLASSIFICATION_CONFIDENCE",
    );
  });
  it("similarity == minSimilarity passes; just below fails", () => {
    expect(codes(ok({ similarity: 0.6, nextSimilarity: null }))).toEqual([]);
    expect(codes(ok({ similarity: 0.5999999, nextSimilarity: null }))).toContain("BELOW_SIMILARITY_THRESHOLD");
  });
  it("margin == minMargin passes; just below is ambiguous", () => {
    const c = resolveGuardConfig({ minMargin: 0.25 });
    expect(codes(ok({ similarity: 0.75, nextSimilarity: 0.5 }), c)).toEqual([]);
    expect(codes(ok({ similarity: 0.75, nextSimilarity: 0.5000001 }), c)).toEqual(["AMBIGUOUS_MATCH"]);
  });
  it("sharedTags == minSharedTags is compatible; one fewer is a mismatch", () => {
    const c = resolveGuardConfig({ minSharedTags: 2 });
    const base = { article: { category: "travel", tags: ["tree", "river"] } };
    expect(codes(ok(base), c)).toEqual([]);
    expect(codes(ok({ article: { category: "travel", tags: ["tree"] } }), c)).toEqual(["CATEGORY_MISMATCH"]);
  });
  it("minSharedTags = 0 never produces a category mismatch", () => {
    expect(codes(ok({ article: { category: "finance", tags: [] } }), resolveGuardConfig({ minSharedTags: 0 }))).toEqual(
      [],
    );
  });
  it("confidence 0 and 1 are valid values", () => {
    expect(codes(ok({ classification: { category: "nature", tags: ["river"], confidence: 1 } }))).toEqual([]);
    expect(
      codes(
        ok({ classification: { category: "nature", tags: ["river"], confidence: 0 } }),
        resolveGuardConfig({ minConfidence: 0 }),
      ),
    ).toEqual([]);
  });
});

describe("invalid numeric inputs never produce an accept", () => {
  it.each([NaN, Infinity, -Infinity, 1.5, -0.1])("confidence %s fails the confidence rule", (confidence) => {
    const r = evaluateMatch(ok({ classification: { category: "nature", tags: ["river"], confidence } }));
    expect(r.decision).not.toBe("accept");
    expect(r.reasons.map((x) => x.code)).toContain("LOW_CLASSIFICATION_CONFIDENCE");
    expect(r.reasons[0]?.explanation).toMatch(/not a valid number/);
  });
  it.each([NaN, Infinity, -Infinity, 1.01, -1.01])("similarity %s fails the similarity rule", (similarity) => {
    const r = evaluateMatch(ok({ similarity, nextSimilarity: null }));
    expect(r.decision).toBe("reject");
    expect(r.reasons.map((x) => x.code)).toContain("BELOW_SIMILARITY_THRESHOLD");
    expect(r.reasons.find((x) => x.code === "BELOW_SIMILARITY_THRESHOLD")?.explanation).toMatch(
      /not a valid cosine similarity/,
    );
  });
  it("tiny float overshoot (1.0000001) is tolerated", () => {
    expect(codes(ok({ similarity: 1.0000001, nextSimilarity: null }))).toEqual([]);
  });
  it("NaN runner-up similarity cannot be assessed, so the match is ambiguous (never accepted)", () => {
    const r = evaluateMatch(ok({ nextSimilarity: NaN }));
    expect(r.decision).toBe("review");
    expect(r.reasons.map((x) => x.code)).toContain("AMBIGUOUS_MATCH");
  });
  it("negative margin (runner-up better than 'rank 1') is ambiguous", () => {
    expect(codes(ok({ similarity: 0.7, nextSimilarity: 0.9 }))).toEqual(["AMBIGUOUS_MATCH"]);
  });
  it.each([0, -1, 1.5, NaN, Infinity])("structurally invalid rank %s throws GuardInputError", (rank) => {
    expect(() => evaluateMatch(ok({ rank }))).toThrow(GuardInputError);
  });
  it("non-number scores throw instead of being coerced", () => {
    expect(() => evaluateMatch(ok({ similarity: "0.9" as never }))).toThrow(GuardInputError);
    expect(() => evaluateMatch(ok({ classification: { confidence: "0.9" as never } }))).toThrow(GuardInputError);
    expect(() => evaluateMatch(ok({ nextSimilarity: "0.1" as never }))).toThrow(GuardInputError);
  });
});

describe("ambiguity only applies to the top candidate with a runner-up", () => {
  it("rank 2 is never flagged ambiguous", () => {
    expect(codes(ok({ rank: 2, similarity: 0.8, nextSimilarity: 0.8 }))).toEqual([]);
  });
  it("no runner-up (null/undefined) -> no ambiguity and margin is null", () => {
    expect(evaluateMatch(ok({ nextSimilarity: null })).signals.margin).toBeNull();
    expect(evaluateMatch(ok({ nextSimilarity: undefined })).decision).toBe("accept");
  });
  it("minMargin 0 tolerates an exact tie", () => {
    expect(codes(ok({ similarity: 0.8, nextSimilarity: 0.8 }), resolveGuardConfig({ minMargin: 0 }))).toEqual([]);
  });
});

describe("empty and missing categories/tags", () => {
  it("no category on either side -> no category rule", () => {
    expect(
      codes(ok({ classification: { category: "", tags: [], confidence: 0.9 }, article: { category: null, tags: [] } })),
    ).toEqual([]);
    expect(
      codes(
        ok({ classification: { category: "nature", tags: [], confidence: 0.9 }, article: { category: undefined } }),
      ),
    ).toEqual([]);
  });
  it("only one side declaring a category is not judged", () => {
    expect(codes(ok({ article: { category: "", tags: [] } }))).toEqual([]);
  });
  it("empty tags on both sides with differing categories is a mismatch", () => {
    expect(
      codes(
        ok({
          classification: { category: "nature", tags: [], confidence: 0.9 },
          article: { category: "finance", tags: [] },
        }),
      ),
    ).toEqual(["CATEGORY_MISMATCH"]);
  });
  it("garbage tag values are ignored safely", () => {
    const r = evaluateMatch(
      ok({
        classification: { category: "nature", tags: [null, 3, {}, "  ", "River"], confidence: 0.9 },
        article: { category: "travel", tags: ["river", undefined] },
      }),
    );
    expect(r.signals.sharedTagCount).toBe(1);
    expect(r.decision).toBe("accept");
    expect(() =>
      evaluateMatch(
        ok({ classification: { category: 7, tags: "tree" as never, confidence: 0.9 }, article: { tags: 5 as never } }),
      ),
    ).not.toThrow();
  });
});

describe("normalization", () => {
  it("normalizeLabel trims, lowercases, collapses whitespace and applies NFKC", () => {
    expect(normalizeLabel("  Wild   LIFE ")).toBe("wild life");
    expect(normalizeLabel("ＮＡＴＵＲＥ")).toBe("nature");
    expect(normalizeLabel(null)).toBe("");
    expect(normalizeLabel(42)).toBe("");
  });
  it("normalizeLabels dedupes, drops empties, preserves order, tolerates non-arrays", () => {
    expect(normalizeLabels([" Tree", "tree", "", "RIVER", null])).toEqual(["tree", "river"]);
    expect(normalizeLabels("tree")).toEqual([]);
    expect(normalizeLabels(undefined)).toEqual([]);
  });
  it("category comparison is case/space/unicode insensitive", () => {
    expect(codes(ok({ article: { category: "  NATURE ", tags: [] } }))).toEqual([]);
  });
});

describe("determinism and purity", () => {
  it("same input -> identical output, and the input is not mutated", () => {
    const input = ok({ classification: { category: " Nature ", tags: ["B", "a"], confidence: 0.9 } });
    const snapshot = JSON.parse(JSON.stringify(input));
    expect(evaluateMatch(input)).toEqual(evaluateMatch(input));
    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);
  });
});

describe("guard configuration", () => {
  it("defaults come from the shared constants", () => {
    expect(resolveGuardConfig()).toEqual({ ...GUARD_DEFAULTS });
  });
  it("undefined overrides keep defaults", () => {
    expect(resolveGuardConfig({ minConfidence: undefined, minMargin: 0.1 })).toEqual({
      ...GUARD_DEFAULTS,
      minMargin: 0.1,
    });
  });
  it.each([
    { minConfidence: NaN },
    { minConfidence: 1.1 },
    { minConfidence: -0.1 },
    { minSimilarity: Infinity },
    { minSimilarity: 2 },
    { minMargin: -0.01 },
    { minSharedTags: 1.5 },
    { minSharedTags: -1 },
  ])("rejects invalid config %j", (bad) => {
    expect(() => resolveGuardConfig(bad)).toThrow(MatchingError);
  });
  it("evaluateMatch refuses an invalid config object instead of silently weakening the guard", () => {
    expect(() => evaluateMatch(ok(), { ...cfg, minSimilarity: NaN })).toThrow();
    expect(() => evaluateMatch(ok(), { ...cfg, extra: 1 } as never)).toThrow();
  });
  it("guardConfigFromEnv applies validated overrides and keeps defaults otherwise", () => {
    expect(guardConfigFromEnv(loadEnv({}))).toEqual({ ...GUARD_DEFAULTS });
    expect(guardConfigFromEnv(loadEnv({ GUARD_MIN_SIMILARITY: "0.7", GUARD_MIN_SHARED_TAGS: "2" }))).toEqual({
      ...GUARD_DEFAULTS,
      minSimilarity: 0.7,
      minSharedTags: 2,
    });
    expect(() => guardConfigFromEnv(loadEnv({ GUARD_MIN_CONFIDENCE: "5" }))).toThrow(MatchingError);
    expect(() => loadEnv({ GUARD_MIN_MARGIN: "abc" })).toThrow(/Invalid environment/);
    expect(loadEnv({ GUARD_MIN_MARGIN: "" }).GUARD_MIN_MARGIN).toBeUndefined();
  });
});
