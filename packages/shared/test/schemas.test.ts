import { describe, expect, it } from "vitest";
import {
  ArticleInputSchema,
  EMBEDDING_DIMENSION,
  EmbeddingVectorSchema,
  ImagePathSchema,
  ReviewInputSchema,
  VisionClassificationSchema,
} from "../src/index.js";

describe("shared schemas", () => {
  it.each(["../x.png", "/etc/a.png", "a\\b.png", "C:/x.png", "a/b.gif", "a\0.png"])(
    "rejects unsafe image path %j",
    (p) => {
      expect(ImagePathSchema.safeParse(p).success).toBe(false);
    },
  );
  it("accepts a safe relative image path", () => {
    expect(ImagePathSchema.safeParse("sports/a.JPG").success).toBe(true);
  });
  it("rejects extra fields and out-of-range confidence in AI output (strict)", () => {
    expect(VisionClassificationSchema.safeParse({ category: "a", tags: [], confidence: 0.5, extra: 1 }).success).toBe(
      false,
    );
    expect(VisionClassificationSchema.safeParse({ category: "a", tags: [], confidence: 1.5 }).success).toBe(false);
    expect(VisionClassificationSchema.safeParse({ category: "a", tags: ["x"], confidence: 0.9 }).success).toBe(true);
  });
  it("enforces embedding dimension and finiteness", () => {
    expect(EmbeddingVectorSchema.safeParse(new Array(EMBEDDING_DIMENSION).fill(0.1)).success).toBe(true);
    expect(EmbeddingVectorSchema.safeParse([1, 2]).success).toBe(false);
    expect(EmbeddingVectorSchema.safeParse(new Array(EMBEDDING_DIMENSION).fill(NaN)).success).toBe(false);
  });
  it("requires review notes and trims article input", () => {
    expect(ReviewInputSchema.safeParse({ reviewer: "a", decision: "approved", notes: " " }).success).toBe(false);
    const a = ArticleInputSchema.parse({ title: " T ", body: " B " });
    expect(a.title).toBe("T");
    expect(a.tags).toEqual([]);
  });
});
