import { describe, expect, it } from "vitest";
import { EMBEDDING_DIMENSION } from "@iam/shared";
import { createMockProvider, embedTextValidated, lexicalHashEmbed } from "../../src/ai/index.js";

const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);

describe("mock provider", () => {
  it("embeddings are deterministic, 768-dim, finite and unit length", () => {
    const a = lexicalHashEmbed("mountain lake sunrise hiking");
    expect(a).toEqual(lexicalHashEmbed("mountain lake sunrise hiking"));
    expect(a).toHaveLength(EMBEDDING_DIMENSION);
    expect(Math.sqrt(a.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 6);
  });
  it("shares-words texts are more similar than unrelated ones (lexical proxy only)", () => {
    const base = lexicalHashEmbed("mountain lake sunrise hiking trail");
    expect(cosine(base, lexicalHashEmbed("hiking trail near a mountain lake"))).toBeGreaterThan(
      cosine(base, lexicalHashEmbed("stock market interest rates inflation")),
    );
  });
  it("falls back to a deterministic hash-based classification and uses fixtures when given", async () => {
    const img = { base64: "AAAA", mimeType: "image/png" as const };
    const p = createMockProvider();
    expect((await p.classifyImage(img)).rawOutput).toEqual((await p.classifyImage(img)).rawOutput);
    const f = createMockProvider({
      classifications: { "x.png": { category: "food", tags: ["pizza"], confidence: 0.8 } },
    });
    expect((await f.classifyImage({ ...img, imageRef: "dir/x.png" })).rawOutput).toEqual({
      category: "food",
      tags: ["pizza"],
      confidence: 0.8,
    });
  });
  it("records call sizes but never image bytes", async () => {
    const p = createMockProvider();
    await p.classifyImage({ base64: "SECRETBYTES", mimeType: "image/png", imageRef: "a.png" });
    await embedTextValidated(p, "hello world text");
    expect(JSON.stringify(p.calls)).not.toContain("SECRETBYTES");
    expect(p.calls.map((c) => c.operation)).toEqual(["classify", "embed"]);
  });
  it("identifies itself as a test double", () => {
    const p = createMockProvider();
    expect([p.name, p.visionModel, p.embeddingModel]).toEqual(["mock", "mock-vision", "mock-lexical-hash"]);
  });
});
