import { describe, expect, it, vi } from "vitest";
import {
  ProviderRequestError,
  ProviderTimeoutError,
  createMockProvider,
  embedTextValidated,
  type ProviderUsage,
} from "../../src/ai/index.js";
import { ensureArticleEmbedding, ensureImageClassification, ensureImageEmbedding } from "../../src/matching/index.js";
import { estimateCost, parsePricing, withUsageTracking } from "../../src/jobs/usage.js";
import type { UsageEntry } from "../../src/jobs/types.js";
import { FakeStore } from "../matching/fakeStore.js";

const rate = { "m-priced": { inputPer1M: 2, outputPer1M: 10 } };
const reported = (i: number | null, o: number | null): ProviderUsage => ({
  inputTokens: i,
  outputTokens: o,
  estimated: false,
});

describe("estimateCost: unknown stays unknown", () => {
  it("no configured rate -> null (never zero)", () => {
    expect(estimateCost("anything", reported(1000, 100), {})).toEqual({ costUsd: null, basis: "no_rate_configured" });
  });
  it("a configured rate and reported tokens -> an estimate", () => {
    expect(estimateCost("m-priced", reported(1_000_000, 100_000), rate)).toEqual({
      costUsd: 3,
      basis: "configured_rate_estimate",
    });
    expect(estimateCost("m-priced", reported(1000, 0), rate).costUsd).toBeCloseTo(0.002, 10);
  });
  it.each([
    ["locally ESTIMATED tokens", { inputTokens: 10, outputTokens: 0, estimated: true } as ProviderUsage],
    ["missing input tokens", reported(null, 5)],
    ["missing output tokens at a non-zero output rate", reported(10, null)],
  ])("%s -> tokens_unavailable, no cost", (_n, usage) => {
    expect(estimateCost("m-priced", usage, rate)).toEqual({ costUsd: null, basis: "tokens_unavailable" });
  });
  it("no usage at all (e.g. a failed call) -> tokens_unavailable when a rate exists", () => {
    expect(estimateCost("m-priced", null, rate)).toEqual({ costUsd: null, basis: "tokens_unavailable" });
  });
  it("a zero OUTPUT rate does not need output tokens (embeddings)", () => {
    expect(estimateCost("emb", reported(1_000_000, null), { emb: { inputPer1M: 0.5, outputPer1M: 0 } })).toEqual({
      costUsd: 0.5,
      basis: "configured_rate_estimate",
    });
  });
});

describe("parsePricing", () => {
  it("returns an empty table when unset (no built-in prices)", () => {
    expect(parsePricing(undefined)).toEqual({});
    expect(parsePricing("  ")).toEqual({});
  });
  it("parses a valid table and rejects malformed ones", () => {
    expect(parsePricing(JSON.stringify(rate))).toEqual(rate);
    expect(() => parsePricing("{nope")).toThrow(/not valid JSON/);
    expect(() => parsePricing(JSON.stringify({ m: { inputPer1M: -1, outputPer1M: 0 } }))).toThrow(/invalid/);
    expect(() => parsePricing(JSON.stringify({ m: { inputPer1M: 1 } }))).toThrow(/invalid/);
    expect(() => parsePricing(JSON.stringify({ m: { inputPer1M: 1, outputPer1M: 1, extra: 1 } }))).toThrow(/invalid/);
  });
});

describe("withUsageTracking", () => {
  const setup = (over: Partial<Parameters<typeof withUsageTracking>[1]> = {}) => {
    const entries: UsageEntry[] = [];
    let t = 1000;
    const base = createMockProvider({
      classifications: { "a.png": { category: "nature", tags: ["x"], confidence: 0.9 } },
    });
    const opts = {
      jobId: "job1",
      attempt: 2,
      operation: "classify_image" as const,
      record: async (e: UsageEntry) => void entries.push(e),
      pricing: {},
      now: () => (t += 25),
      ...over,
    };
    return { base, entries, tracked: withUsageTracking(base, opts) };
  };

  it("records a successful call with provider, model, latency, tokens and the attempt; cost unknown without a rate", async () => {
    const { tracked, entries } = setup();
    await tracked.classifyImage({ base64: "aGVsbG8=", mimeType: "image/png", imageRef: "a.png" });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      jobId: "job1",
      attempt: 2,
      operation: "classify_image",
      provider: "mock",
      model: "mock-vision",
      success: true,
      errorCode: null,
      latencyMs: 25,
      estimatedCostUsd: null,
      costBasis: "no_rate_configured",
    });
    expect(entries[0]?.usage?.inputTokens).toBe(258);
  });

  it("records a FAILED call with a stable error code, keeps the original error, and uses error usage when present", async () => {
    const { base, tracked, entries } = setup();
    const err = new ProviderTimeoutError(1000);
    base.failNext(1, () => err);
    await expect(tracked.classifyImage({ base64: "aGVsbG8=", mimeType: "image/png" })).rejects.toBe(err);
    expect(entries[0]).toMatchObject({
      success: false,
      errorCode: "provider_timeout",
      costBasis: "no_rate_configured",
      estimatedCostUsd: null,
    });
  });

  it("a billed-but-failed call keeps its reported token usage", async () => {
    const { base, tracked, entries } = setup({ pricing: { "mock-vision": { inputPer1M: 1, outputPer1M: 1 } } });
    base.failNext(1, () => new ProviderRequestError("blocked", { retryable: false, usage: reported(500, 0) }));
    await expect(tracked.classifyImage({ base64: "aGVsbG8=", mimeType: "image/png" })).rejects.toBeDefined();
    expect(entries[0]).toMatchObject({
      success: false,
      estimatedCostUsd: 0.0005,
      costBasis: "configured_rate_estimate",
    });
    expect(entries[0]?.usage?.inputTokens).toBe(500);
  });

  it("uses the embedding model for embed operations and the configured rate only when tokens are REPORTED", async () => {
    const { tracked, entries } = setup({
      operation: "embed_article",
      pricing: { "mock-lexical-hash": { inputPer1M: 1, outputPer1M: 0 } },
    });
    await tracked.embedText("some article text");
    expect(entries[0]).toMatchObject({
      operation: "embed_article",
      model: "mock-lexical-hash",
      costBasis: "tokens_unavailable",
      estimatedCostUsd: null,
    }); // mock tokens are local estimates
  });

  it("a ledger write failure never fails the call or loses the AI result", async () => {
    const onRecordError = vi.fn();
    const { tracked } = setup({ record: async () => Promise.reject(new Error("db down")), onRecordError });
    const out = await tracked.classifyImage({ base64: "aGVsbG8=", mimeType: "image/png", imageRef: "a.png" });
    expect(out.rawOutput).toMatchObject({ category: "nature" });
    expect(onRecordError).toHaveBeenCalledTimes(1);
  });

  it("is transparent: same name and models, and invalid output still reaches validation", async () => {
    const { tracked, base } = setup();
    expect([tracked.name, tracked.visionModel, tracked.embeddingModel]).toEqual([
      base.name,
      base.visionModel,
      base.embeddingModel,
    ]);
    const bad = withUsageTracking(createMockProvider({ embedFn: () => new Array(10).fill(1) }), {
      jobId: "j",
      attempt: 1,
      operation: "embed_image",
      record: async () => {},
      pricing: {},
    });
    await expect(embedTextValidated(bad, "text")).rejects.toMatchObject({ code: "invalid_embedding" });
  });
});

describe("reused results create NO usage rows", () => {
  it("a second preparation pass makes no provider calls, so the ledger gets nothing", async () => {
    const s = new FakeStore();
    s.addImage("i1", "forest.png");
    s.addArticle("a1");
    const entries: UsageEntry[] = [];
    const record = async (e: UsageEntry) => void entries.push(e);
    const base = createMockProvider({
      classifications: { "forest.png": { category: "nature", tags: ["forest"], confidence: 0.9 } },
    });
    const run = async (attempt: number) => {
      const t = (operation: "classify_image" | "embed_image" | "embed_article") =>
        withUsageTracking(base, { jobId: "j", attempt, operation, record, pricing: {} });
      await ensureImageClassification({
        store: s,
        provider: t("classify_image"),
        imageId: "i1",
        loadImage: async () => ({ base64: "aGVsbG8=", mimeType: "image/png" }),
      });
      await ensureImageEmbedding({ store: s, provider: t("embed_image"), imageId: "i1" });
      await ensureArticleEmbedding({ store: s, provider: t("embed_article"), articleId: "a1" });
    };
    await run(1);
    expect(entries.map((e) => e.operation)).toEqual(["classify_image", "embed_image", "embed_article"]);
    await run(2); // a retry after everything was already stored
    expect(entries).toHaveLength(3);
  });
});
