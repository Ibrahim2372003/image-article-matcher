import { describe, expect, it, vi } from "vitest";
import { EMBEDDING_DIMENSION, EMBEDDING_MODEL } from "@iam/shared";
import {
  InvalidEmbeddingError,
  ProviderConfigError,
  ProviderOutputError,
  ProviderRequestError,
  ProviderTimeoutError,
  classifyImageValidated,
  createGeminiProvider,
  embedTextValidated,
  l2Normalize,
  type GeminiClientLike,
} from "../../src/ai/index.js";

const KEY = "AIzaSyFAKE-test-key-1234567890";
const IMG = { base64: "aGVsbG8=", mimeType: "image/jpeg" as const };

function fakeClient(over: Partial<GeminiClientLike["models"]> = {}) {
  const generateContent = vi.fn(async (_p: unknown) => ({
    text: JSON.stringify({ category: "nature", tags: ["tree"], confidence: 0.9 }),
    usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 20 },
  }));
  const embedContent = vi.fn(async (_p: unknown) => ({
    embeddings: [{ values: new Array(768).fill(2) }],
    usageMetadata: { promptTokenCount: 5 },
  }));
  const client: GeminiClientLike = { models: { generateContent, embedContent, ...over } as GeminiClientLike["models"] };
  return { client, generateContent, embedContent };
}
const make = (client: GeminiClientLike, timeoutMs = 1000) =>
  createGeminiProvider({ apiKey: KEY, visionModel: "gemini-test-vision", client, timeoutMs });

describe("gemini provider", () => {
  it("requires an API key", () => {
    expect(() => createGeminiProvider({ apiKey: "", visionModel: "m" })).toThrow(ProviderConfigError);
  });

  it("sends a JSON-schema constrained, temperature-0 request with the image as inline data", async () => {
    const { client, generateContent } = fakeClient();
    const r = await classifyImageValidated(make(client), IMG);
    expect(r.classification.category).toBe("nature");
    expect(r.usage).toEqual({ inputTokens: 300, outputTokens: 20, estimated: false });
    const params = generateContent.mock.calls[0]?.[0] as {
      model: string;
      contents: Array<{ parts: unknown[] }>;
      config: Record<string, unknown>;
    };
    expect(params.model).toBe("gemini-test-vision");
    expect(params.config).toMatchObject({ temperature: 0, responseMimeType: "application/json" });
    expect(params.config.responseJsonSchema).toBeDefined();
    expect(params.contents[0]?.parts[1]).toEqual({ inlineData: { mimeType: "image/jpeg", data: IMG.base64 } });
  });

  it("explicitly requests 768 dimensions from gemini-embedding-001 (default would be 3072)", async () => {
    const { client, embedContent } = fakeClient();
    await embedTextValidated(make(client), "some text");
    expect(embedContent.mock.calls[0]?.[0]).toMatchObject({
      model: EMBEDDING_MODEL,
      contents: "some text",
      config: { taskType: "SEMANTIC_SIMILARITY", outputDimensionality: EMBEDDING_DIMENSION },
    });
  });

  it("L2-normalizes reduced-dimension vectors without changing their length", async () => {
    const { client } = fakeClient();
    const r = await embedTextValidated(make(client), "t");
    expect(r.vector).toHaveLength(768);
    expect(Math.sqrt(r.vector.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 6);
    expect(l2Normalize([0, 0])).toEqual([0, 0]); // zero vector left for validation to reject
  });

  it("does NOT truncate or pad: a 3072-dim response is rejected", async () => {
    const { client } = fakeClient({
      embedContent: async () => ({ embeddings: [{ values: new Array(3072).fill(1) }] }),
    });
    await expect(embedTextValidated(make(client), "t")).rejects.toBeInstanceOf(InvalidEmbeddingError);
  });

  it("rejects an embedding containing NaN", async () => {
    const { client } = fakeClient({
      embedContent: async () => ({ embeddings: [{ values: [NaN, ...new Array(767).fill(1)] }] }),
    });
    await expect(embedTextValidated(make(client), "t")).rejects.toBeInstanceOf(InvalidEmbeddingError);
  });

  it.each([
    ["no embeddings", { embeddings: [] }],
    ["no values", { embeddings: [{}] }],
    ["missing field", {}],
  ])("malformed embedding response (%s) is a ProviderOutputError", async (_l, resp) => {
    const { client } = fakeClient({ embedContent: async () => resp as never });
    await expect(embedTextValidated(make(client), "t")).rejects.toBeInstanceOf(ProviderOutputError);
  });

  it.each([
    ["empty text", { text: "" }],
    ["missing text", {}],
    ["non-JSON text", { text: "I think it is a tree" }],
  ])("malformed classification response (%s) is a retryable ProviderOutputError", async (_l, resp) => {
    const { client } = fakeClient({ generateContent: async () => resp });
    const err = await classifyImageValidated(make(client), IMG).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderOutputError);
    expect((err as ProviderOutputError).retryable).toBe(true);
  });

  it("JSON that fails the schema is rejected by validation, not accepted", async () => {
    const { client } = fakeClient({
      generateContent: async () => ({ text: JSON.stringify({ category: "nature", tags: [], confidence: 7 }) }),
    });
    await expect(classifyImageValidated(make(client), IMG)).rejects.toMatchObject({ code: "invalid_classification" });
  });

  it("does not invent token counts when the API reports none", async () => {
    const { client } = fakeClient({
      generateContent: async () => ({ text: JSON.stringify({ category: "nature", tags: [], confidence: 0.5 }) }),
    });
    const r = await classifyImageValidated(make(client), IMG);
    expect(r.usage).toEqual({ inputTokens: null, outputTokens: null, estimated: true });
  });

  it("a safety block is a permanent request error carrying usage", async () => {
    const { client } = fakeClient({
      generateContent: async () => ({
        promptFeedback: { blockReason: "SAFETY" },
        usageMetadata: { promptTokenCount: 10 },
      }),
    });
    const err = (await classifyImageValidated(make(client), IMG).catch((e: unknown) => e)) as ProviderRequestError;
    expect(err).toBeInstanceOf(ProviderRequestError);
    expect(err.retryable).toBe(false);
    expect(err.usage?.inputTokens).toBe(10);
  });

  it.each([
    [429, true],
    [500, true],
    [503, true],
    [401, false],
    [403, false],
    [400, false],
  ])("HTTP %i from the SDK maps to retryable=%s", async (status, retryable) => {
    const { client } = fakeClient({
      generateContent: async () => Promise.reject(Object.assign(new Error("api error"), { status })),
    });
    const err = (await classifyImageValidated(make(client), IMG).catch((e: unknown) => e)) as ProviderRequestError;
    expect(err).toBeInstanceOf(ProviderRequestError);
    expect(err.status).toBe(status);
    expect(err.retryable).toBe(retryable);
  });

  it("network errors are retryable request errors", async () => {
    const { client } = fakeClient({ embedContent: async () => Promise.reject(new Error("ECONNRESET")) });
    const err = (await embedTextValidated(make(client), "t").catch((e: unknown) => e)) as ProviderRequestError;
    expect(err.retryable).toBe(true);
  });

  it("times out even if the client ignores the abort signal", async () => {
    const { client } = fakeClient({ generateContent: () => new Promise(() => {}) });
    const err = await classifyImageValidated(make(client, 20), IMG).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderTimeoutError);
    expect((err as ProviderTimeoutError).retryable).toBe(true);
  });

  it("never leaks the API key into error messages, even if the SDK echoes it", async () => {
    const { client } = fakeClient({
      generateContent: async () => Promise.reject(Object.assign(new Error(`bad key ${KEY} rejected`), { status: 400 })),
    });
    const err = (await classifyImageValidated(make(client), IMG).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(KEY);
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(KEY);
    expect(err.message).toContain("[redacted]");
  });
});
