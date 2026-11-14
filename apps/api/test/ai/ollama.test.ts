import { describe, expect, it, vi } from "vitest";
import {
  InvalidEmbeddingError,
  ProviderConfigError,
  ProviderOutputError,
  ProviderRequestError,
  ProviderTimeoutError,
  classifyImageValidated,
  createOllamaProvider,
  embedTextValidated,
} from "../../src/ai/index.js";

const IMG = { base64: "aGVsbG8=", mimeType: "image/png" as const };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function make(fetchImpl: typeof fetch, baseUrl = "http://localhost:11434/", timeoutMs = 1000) {
  return createOllamaProvider({
    baseUrl,
    visionModel: "vision-test",
    embeddingModel: "embed-test",
    fetchImpl,
    timeoutMs,
  });
}

describe("ollama provider", () => {
  it("rejects invalid base URLs", () => {
    expect(() => make(fetch, "not a url")).toThrow(ProviderConfigError);
    expect(() => make(fetch, "file:///etc/passwd")).toThrow(ProviderConfigError);
  });

  it("classifies via /api/chat with the image as base64 and a JSON schema format", async () => {
    const f = vi.fn(async (_u: unknown, _i?: unknown) =>
      json({
        message: { content: JSON.stringify({ category: "food", tags: ["pizza"], confidence: 0.7 }) },
        prompt_eval_count: 12,
        eval_count: 9,
      }),
    );
    const r = await classifyImageValidated(make(f as never), IMG);
    expect(r.classification.category).toBe("food");
    expect(r.usage).toEqual({ inputTokens: 12, outputTokens: 9, estimated: false });
    const [url, init] = f.mock.calls[0] as [string, { body: string }];
    expect(url).toBe("http://localhost:11434/api/chat"); // trailing slash normalised
    const body = JSON.parse(init.body) as {
      model: string;
      stream: boolean;
      format: unknown;
      messages: Array<{ images: string[] }>;
    };
    expect(body).toMatchObject({ model: "vision-test", stream: false });
    expect(body.format).toBeDefined();
    expect(body.messages[0]?.images).toEqual([IMG.base64]);
  });

  it("embeds via /api/embed and accepts a native 768-dim vector", async () => {
    const f = vi.fn(async (_u: unknown, _i?: unknown) => json({ embeddings: [new Array(768).fill(0.05)] }));
    const r = await embedTextValidated(make(f as never), "hello text");
    expect(r.vector).toHaveLength(768);
    expect(r.model).toBe("embed-test");
    expect(f.mock.calls[0]?.[0]).toBe("http://localhost:11434/api/embed");
    expect(JSON.parse((f.mock.calls[0]?.[1] as { body: string }).body)).toEqual({
      model: "embed-test",
      input: "hello text",
    });
  });

  it("rejects a model with the wrong native dimension (e.g. 1024) instead of adjusting it", async () => {
    const f = async () => json({ embeddings: [new Array(1024).fill(0.05)] });
    const err = await embedTextValidated(make(f as never), "t").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidEmbeddingError);
    expect((err as Error).message).toMatch(/provider returned 1024 values/);
  });

  it("maps HTTP errors: 500 retryable, 404 not retryable with a pull hint", async () => {
    const e500 = (await classifyImageValidated(make((async () => json({ error: "boom" }, 500)) as never), IMG).catch(
      (e: unknown) => e,
    )) as ProviderRequestError;
    expect(e500.retryable).toBe(true);
    const e404 = (await classifyImageValidated(
      make((async () => json({ error: "model not found" }, 404)) as never),
      IMG,
    ).catch((e: unknown) => e)) as ProviderRequestError;
    expect(e404.retryable).toBe(false);
    expect(e404.message).toMatch(/ollama pull/);
  });

  it("an unreachable server is a retryable request error naming the host only", async () => {
    const err = (await embedTextValidated(
      make((async () => Promise.reject(new TypeError("fetch failed"))) as never),
      "t",
    ).catch((e: unknown) => e)) as ProviderRequestError;
    expect(err).toBeInstanceOf(ProviderRequestError);
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("localhost:11434");
  });

  it("times out via the abort signal", async () => {
    const hang = ((_u: unknown, init: { signal: AbortSignal }) =>
      new Promise((_r, reject) =>
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
      )) as never;
    const err = await classifyImageValidated(make(hang, "http://localhost:11434", 20), IMG).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderTimeoutError);
  });

  it.each([
    ["no content", { message: {} }],
    ["non-JSON content", { message: { content: "a nice picture" } }],
    ["no embeddings array", { embeddings: "x" }],
  ])("malformed response (%s) is a ProviderOutputError", async (_l, body) => {
    const f = (async () => json(body)) as never;
    const op = "embeddings" in body ? embedTextValidated(make(f), "t") : classifyImageValidated(make(f), IMG);
    await expect(op).rejects.toBeInstanceOf(ProviderOutputError);
  });
});
