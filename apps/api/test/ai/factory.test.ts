import { describe, expect, it, vi } from "vitest";
import { loadEnv } from "../../src/env.js";
import { ProviderConfigError, createProvider, describeProvider, type GeminiClientLike } from "../../src/ai/index.js";

const fakeClient: GeminiClientLike = { models: { generateContent: vi.fn(), embedContent: vi.fn() } as never };

describe("createProvider", () => {
  it("selects the mock provider by default and warns that it is a test double", () => {
    const warn = vi.fn();
    const p = createProvider(loadEnv({}), { warn });
    expect(p.name).toBe("mock");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("NOT real AI"));
  });

  it("selects gemini when configured and uses the configured vision model", () => {
    const p = createProvider(
      loadEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "k-123456", GEMINI_VISION_MODEL: "gemini-x" }),
      { geminiClient: fakeClient },
    );
    expect(p.name).toBe("gemini");
    expect(p.visionModel).toBe("gemini-x");
    expect(p.embeddingModel).toBe("gemini-embedding-001");
  });

  it("selects ollama with its configured models", () => {
    const p = createProvider(loadEnv({ AI_PROVIDER: "ollama", OLLAMA_VISION_MODEL: "v", OLLAMA_EMBEDDING_MODEL: "e" }));
    expect(p.name).toBe("ollama");
    expect([p.visionModel, p.embeddingModel]).toEqual(["v", "e"]);
  });

  it("fails clearly for gemini without a key (env loader and factory both refuse)", () => {
    expect(() => loadEnv({ AI_PROVIDER: "gemini" })).toThrow(/GEMINI_API_KEY/);
    const env = loadEnv({});
    expect(() => createProvider({ ...env, AI_PROVIDER: "gemini" })).toThrow(ProviderConfigError);
  });

  it("fails clearly for an unsupported provider instead of falling back", () => {
    const env = loadEnv({});
    expect(() => createProvider({ ...env, AI_PROVIDER: "openai" as never })).toThrow(
      /Unsupported AI_PROVIDER "openai"/,
    );
  });

  it("validates new AI settings", () => {
    expect(() => loadEnv({ AI_PROVIDER: "openai" })).toThrow(/Invalid environment/);
    expect(() => loadEnv({ AI_TIMEOUT_MS: "5" })).toThrow(/Invalid environment/);
    expect(loadEnv({}).OLLAMA_EMBEDDING_MODEL).toBe("nomic-embed-text");
  });

  it("describeProvider never includes secrets", () => {
    const p = createProvider(loadEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "super-secret-key-xyz" }), {
      geminiClient: fakeClient,
    });
    expect(describeProvider(p)).not.toContain("super-secret-key-xyz");
  });
});
