import { describe, expect, it, vi } from "vitest";
import { EMBEDDING_DIMENSION, EMBEDDING_TASK_TYPE } from "@iam/shared";
import {
  InvalidClassificationError,
  InvalidEmbeddingError,
  ProviderRequestError,
  createMockProvider,
} from "../../src/ai/index.js";
import {
  ArticleNotFoundError,
  ImageNotFoundError,
  MissingPrerequisiteError,
  buildArticleEmbeddingText,
  buildImageEmbeddingText,
  ensureArticleEmbedding,
  ensureImageClassification,
  ensureImageEmbedding,
  generateMatches,
} from "../../src/matching/index.js";
import { FakeStore } from "./fakeStore.js";

const loadImage = vi.fn(async () => ({ base64: "aGVsbG8=", mimeType: "image/png" as const }));
const forest = { category: "nature", tags: ["forest", "river", "trees"], confidence: 0.9 };
const provider = () => createMockProvider({ classifications: { "forest.png": forest } });

function store(): FakeStore {
  const s = new FakeStore();
  s.addImage("i1", "photos/forest.png");
  return s;
}

describe("embedding text builders", () => {
  it("image text comes from validated classification metadata", () => {
    expect(buildImageEmbeddingText({ category: "nature", tags: ["a", "b"] })).toBe("category: nature; tags: a, b");
  });
  it("article text is title + body, truncated to the input limit", () => {
    expect(buildArticleEmbeddingText({ title: "T", body: "B" })).toBe("T\n\nB");
    expect(buildArticleEmbeddingText({ title: "T", body: "x".repeat(10_000) }, 50)).toHaveLength(50);
  });
});

describe("ensureImageClassification", () => {
  it("classifies via the provider, validates, and stores provider/model with the result", async () => {
    const s = store();
    const c = await ensureImageClassification({ store: s, provider: provider(), imageId: "i1", loadImage });
    expect(c).toMatchObject({ ...forest, provider: "mock", model: "mock-vision" });
    expect(await s.getLatestClassification("i1")).toEqual(c);
  });
  it("is idempotent: an existing classification from the same provider/model skips the AI call and image load", async () => {
    const s = store();
    const p = provider();
    await ensureImageClassification({ store: s, provider: p, imageId: "i1", loadImage });
    loadImage.mockClear();
    await ensureImageClassification({ store: s, provider: p, imageId: "i1", loadImage });
    expect(loadImage).not.toHaveBeenCalled();
    expect(p.calls.filter((x) => x.operation === "classify")).toHaveLength(1);
  });
  it("unknown image -> ImageNotFoundError", async () => {
    await expect(
      ensureImageClassification({ store: new FakeStore(), provider: provider(), imageId: "x", loadImage }),
    ).rejects.toBeInstanceOf(ImageNotFoundError);
  });
  it("malformed provider output is rejected and nothing is stored", async () => {
    const s = store();
    const p = createMockProvider({ classify: () => ({ category: "nature", tags: [], confidence: 4 }) });
    await expect(ensureImageClassification({ store: s, provider: p, imageId: "i1", loadImage })).rejects.toBeInstanceOf(
      InvalidClassificationError,
    );
    expect(s.classifications.size).toBe(0);
  });
  it("a provider failure propagates and nothing is stored", async () => {
    const s = store();
    const p = provider();
    p.failNext(1, () => new ProviderRequestError("down", { status: 503 }));
    await expect(ensureImageClassification({ store: s, provider: p, imageId: "i1", loadImage })).rejects.toBeInstanceOf(
      ProviderRequestError,
    );
    expect(s.classifications.size).toBe(0);
  });
});

describe("ensureImageEmbedding", () => {
  it("without a classification it throws MissingPrerequisiteError (not ImageNotFound)", async () => {
    const err = await ensureImageEmbedding({ store: store(), provider: provider(), imageId: "i1" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MissingPrerequisiteError);
    expect(err).toMatchObject({ code: "missing_prerequisite", what: "classification" });
  });
  it("unknown image -> ImageNotFoundError", async () => {
    await expect(
      ensureImageEmbedding({ store: new FakeStore(), provider: provider(), imageId: "x" }),
    ).rejects.toBeInstanceOf(ImageNotFoundError);
  });
  it("stores a 768-dim vector in the provider's model with the project task type; second call is a no-op", async () => {
    const s = store();
    const p = provider();
    await ensureImageClassification({ store: s, provider: p, imageId: "i1", loadImage });
    const first = await ensureImageEmbedding({ store: s, provider: p, imageId: "i1" });
    expect(first).toEqual({ space: { model: "mock-lexical-hash", taskType: EMBEDDING_TASK_TYPE }, created: true });
    expect(s.imageVectors.get("i1")?.[0]?.vector).toHaveLength(EMBEDDING_DIMENSION);
    const second = await ensureImageEmbedding({ store: s, provider: p, imageId: "i1" });
    expect(second.created).toBe(false);
    expect(p.calls.filter((c) => c.operation === "embed")).toHaveLength(1);
  });
  it("a provider returning the wrong dimension is rejected and nothing is stored", async () => {
    const s = store();
    const good = provider();
    await ensureImageClassification({ store: s, provider: good, imageId: "i1", loadImage });
    const bad = createMockProvider({ embedFn: () => new Array(1024).fill(0.1) });
    await expect(ensureImageEmbedding({ store: s, provider: bad, imageId: "i1" })).rejects.toBeInstanceOf(
      InvalidEmbeddingError,
    );
    expect(s.imageVectors.size).toBe(0);
  });
});

describe("ensureArticleEmbedding", () => {
  it("unknown article -> ArticleNotFoundError", async () => {
    await expect(
      ensureArticleEmbedding({ store: new FakeStore(), provider: provider(), articleId: "x" }),
    ).rejects.toBeInstanceOf(ArticleNotFoundError);
  });
  it("uses the SAME model and task type as the image embedding so the two are comparable", async () => {
    const s = store();
    s.addArticle("a1");
    const p = provider();
    await ensureImageClassification({ store: s, provider: p, imageId: "i1", loadImage });
    const img = await ensureImageEmbedding({ store: s, provider: p, imageId: "i1" });
    const art = await ensureArticleEmbedding({ store: s, provider: p, articleId: "a1" });
    expect(art.space).toEqual(img.space);
  });
  it("invalid embeddings are rejected and nothing is stored", async () => {
    const s = store();
    s.addArticle("a1");
    const bad = createMockProvider({ embedFn: () => [NaN, ...new Array(767).fill(0.1)] });
    await expect(ensureArticleEmbedding({ store: s, provider: bad, articleId: "a1" })).rejects.toBeInstanceOf(
      InvalidEmbeddingError,
    );
    expect(s.articleVectors.size).toBe(0);
  });
});

describe("prepare -> match, wired end to end with the mock provider and a fake store", () => {
  it("ranks the semantically related article first; filenames are irrelevant", async () => {
    const s = new FakeStore();
    s.addImage("i1", "finance/stocks.png"); // misleading name; fixture below is keyed by this ref
    s.addArticle("nat", "nature", ["forest"]);
    s.addArticle("fin", "finance", ["stocks"]);
    s.articles.set("nat", {
      id: "nat",
      title: "Forest river trees",
      body: "A walk along the river through the forest among tall trees.",
      category: "nature",
      tags: ["forest"],
    });
    s.articles.set("fin", {
      id: "fin",
      title: "Stocks and interest rates",
      body: "Markets, inflation and bond yields moved this quarter.",
      category: "finance",
      tags: ["stocks"],
    });
    const p = createMockProvider({ classifications: { "stocks.png": forest } });
    await ensureImageClassification({ store: s, provider: p, imageId: "i1", loadImage });
    await ensureImageEmbedding({ store: s, provider: p, imageId: "i1" });
    await ensureArticleEmbedding({ store: s, provider: p, articleId: "nat" });
    await ensureArticleEmbedding({ store: s, provider: p, articleId: "fin" });
    const r = await generateMatches({
      store: s,
      imageId: "i1",
      embeddingModel: p.embeddingModel,
      guardConfig: undefined,
    });
    expect(r.evaluations[0]).toMatchObject({ articleId: "nat", rank: 1 });
    expect(r.evaluations[0]?.similarity).toBeGreaterThan(r.evaluations[1]?.similarity ?? 1);
    expect(r.evaluations.find((e) => e.articleId === "fin")?.decision).toBe("reject");
  });
});
