import { describe, expect, it } from "vitest";
import { EMBEDDING_DIMENSION } from "@iam/shared";
import {
  MatchingError,
  PgMatchStore,
  resolveGuardConfig,
  suggestionKey,
  suggestionKeyPrefix,
  toStorableSimilarity,
  toVectorLiteral,
  type EvaluationRecord,
} from "../../src/matching/index.js";

describe("toVectorLiteral", () => {
  it("formats a 768-dim vector as a pgvector literal", () => {
    const lit = toVectorLiteral(new Array(EMBEDDING_DIMENSION).fill(0.5));
    expect(lit.startsWith("[0.5,")).toBe(true);
    expect(lit.endsWith("]")).toBe(true);
    expect(lit.split(",")).toHaveLength(EMBEDDING_DIMENSION);
  });
  it.each([[[1, 2, 3]], [new Array(769).fill(1)], [[NaN, ...new Array(767).fill(1)]], ["x"], [null]])(
    "rejects invalid vector %#",
    (v) => {
      expect(() => toVectorLiteral(v)).toThrow(MatchingError);
    },
  );
});

describe("toStorableSimilarity", () => {
  it("clamps float overshoot, maps non-finite to null (NaN violates the CHECK constraint)", () => {
    expect(toStorableSimilarity(1.0000001)).toBe(1);
    expect(toStorableSimilarity(-1.2)).toBe(-1);
    expect(toStorableSimilarity(0.42)).toBe(0.42);
    expect(toStorableSimilarity(NaN)).toBeNull();
    expect(toStorableSimilarity(Infinity)).toBeNull();
  });
});

describe("suggestion keys", () => {
  it("one key per (image, article) pair under a per-image prefix", () => {
    expect(suggestionKey("I", "A")).toBe("suggest:I:A");
    expect(suggestionKey("I", "A").startsWith(suggestionKeyPrefix("I"))).toBe(true);
    expect(suggestionKey("I", "A")).not.toBe(suggestionKey("A", "I"));
  });
});

/** Records every statement so the placeholder/parameter wiring can be audited without a database. */
function recorder(insertReturnsRow: boolean, reviewed = false) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = async (sql: unknown, params: unknown[] = []) => {
    const text = String(sql);
    calls.push({ sql: text, params });
    if (/INSERT INTO analysis_jobs/.test(text))
      return { rows: insertReturnsRow ? [{ id: "job-1" }] : [], rowCount: insertReturnsRow ? 1 : 0 };
    if (/FOR UPDATE/.test(text)) return { rows: [{ id: "job-1", status: "completed" }], rowCount: 1 };
    if (/FROM reviews/.test(text)) return { rows: reviewed ? [{ "?column?": 1 }] : [], rowCount: reviewed ? 1 : 0 };
    return { rows: [], rowCount: 0 };
  };
  const client = { query, release: () => {} };
  const db = { query, connect: async () => client } as never;
  return { calls, db };
}
const rec = (articleId: string): EvaluationRecord => ({
  imageId: "img",
  articleId,
  rank: 1,
  classification: { category: "nature", tags: ["a"], confidence: 0.9, provider: "mock", model: "mock-vision" },
  space: { model: "m", taskType: "SEMANTIC_SIMILARITY" },
  similarity: 0.9,
  decision: "accept",
  primaryReasonCode: null,
  reasons: [],
  signals: {
    confidence: 0.9,
    similarity: 0.9,
    rank: 1,
    margin: null,
    sharedTagCount: 0,
    imageCategory: "nature",
    articleCategory: "nature",
  },
  policyVersion: "guard-v1",
  policyConfig: resolveGuardConfig(),
});

describe("SQL wiring audit (no database needed)", () => {
  const assertWired = (calls: Array<{ sql: string; params: unknown[] }>) => {
    for (const { sql, params } of calls) {
      const nums = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
      if (nums.length === 0) {
        expect(params).toHaveLength(0);
        continue;
      }
      const max = Math.max(...nums);
      expect(params, sql).toHaveLength(max); // no missing and no extra parameters
      for (let i = 1; i <= max; i += 1) expect(nums, `$${i} unused in: ${sql}`).toContain(i);
    }
  };

  it("insert path: every placeholder has exactly one parameter, in a single BEGIN..COMMIT", async () => {
    const { calls, db } = recorder(true);
    const out = await new PgMatchStore(db).saveEvaluations([rec("a1"), rec("a2")]);
    expect(out.map((o) => o.outcome)).toEqual(["created", "created"]);
    assertWired(calls);
    const seq = calls.map((c) => c.sql.trim().split(/\s+/)[0]);
    expect(seq[0]).toBe("BEGIN");
    expect(seq.at(-1)).toBe("COMMIT");
    expect(seq.filter((s) => s === "BEGIN")).toHaveLength(1); // one transaction for the whole batch
  });
  it("update path locks first, checks reviews in a LATER statement, then updates and audits", async () => {
    const { calls, db } = recorder(false);
    const out = await new PgMatchStore(db).saveEvaluations([rec("a1")]);
    expect(out[0]?.outcome).toBe("updated");
    assertWired(calls);
    const idx = (re: RegExp) => calls.findIndex((c) => re.test(c.sql));
    expect(idx(/FOR UPDATE/)).toBeGreaterThan(-1);
    expect(idx(/FROM reviews/)).toBeGreaterThan(idx(/FOR UPDATE/));
    expect(idx(/UPDATE analysis_jobs/)).toBeGreaterThan(idx(/FROM reviews/));
    expect(idx(/INSERT INTO job_audit_events/)).toBeGreaterThan(idx(/UPDATE analysis_jobs/));
  });
  it("reviewed rows are left untouched: no UPDATE and no audit event", async () => {
    const { calls, db } = recorder(false, true);
    const out = await new PgMatchStore(db).saveEvaluations([rec("a1")]);
    expect(out[0]?.outcome).toBe("preserved");
    expect(calls.some((c) => /UPDATE analysis_jobs/.test(c.sql))).toBe(false);
    expect(calls.some((c) => /job_audit_events/.test(c.sql))).toBe(false);
  });
  it("rows are processed in articleId order (deadlock avoidance) but results keep input order", async () => {
    const { calls, db } = recorder(true);
    const out = await new PgMatchStore(db).saveEvaluations([rec("zz"), rec("aa")]);
    expect(out.map((o) => o.articleId)).toEqual(["zz", "aa"]);
    const keys = calls.filter((c) => /INSERT INTO analysis_jobs/.test(c.sql)).map((c) => c.params[13]);
    expect(keys).toEqual(["suggest:img:aa", "suggest:img:zz"]);
  });
  it("a failure rolls back the whole batch and releases the connection", async () => {
    const calls: string[] = [];
    let n = 0;
    let released = false;
    const query = async (sql: unknown) => {
      const t = String(sql);
      calls.push(t.trim().split(/\s+/)[0] as string);
      if (/INSERT INTO analysis_jobs/.test(t) && (n += 1) === 2) throw new Error("constraint violation");
      return { rows: /INSERT INTO analysis_jobs/.test(t) ? [{ id: "j" }] : [], rowCount: 1 };
    };
    const db = { query, connect: async () => ({ query, release: () => (released = true) }) } as never;
    await expect(new PgMatchStore(db).saveEvaluations([rec("a1"), rec("a2")])).rejects.toThrow(/constraint violation/);
    expect(calls).toContain("ROLLBACK");
    expect(calls).not.toContain("COMMIT");
    expect(released).toBe(true);
  });
  it("read queries are parameterised too", async () => {
    const { calls, db } = recorder(true);
    const s = new PgMatchStore(db);
    const space = { model: "m", taskType: "t" };
    await s.getImage("i");
    await s.getArticle("a");
    await s.getLatestClassification("i");
    await s.listImageEmbeddingSpaces("i");
    await s.listArticleEmbeddingSpaces();
    await s.hasImageEmbedding("i", space);
    await s.hasArticleEmbedding("a", space);
    await s.findNearestArticles("i", space, 3);
    await s.hasEvaluations("i");
    await s.listEvaluationsForImage("i");
    await s.upsertClassification("i", { category: "c", tags: [], confidence: 0.5, provider: "p", model: "m" }, {});
    await s.upsertImageEmbedding("i", new Array(768).fill(0.1), space);
    await s.upsertArticleEmbedding("a", new Array(768).fill(0.1), space);
    assertWired(calls);
    expect(calls).toHaveLength(13);
  });
});
