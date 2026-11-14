import type { Env } from "../env.js";
import { ProviderConfigError } from "./errors.js";
import { createGeminiProvider, type GeminiClientLike } from "./gemini.js";
import { createMockProvider } from "./mock.js";
import { createOllamaProvider } from "./ollama.js";
import type { AiProvider } from "./types.js";

export type ProviderEnv = Pick<
  Env,
  | "AI_PROVIDER"
  | "GEMINI_API_KEY"
  | "GEMINI_VISION_MODEL"
  | "OLLAMA_BASE_URL"
  | "OLLAMA_VISION_MODEL"
  | "OLLAMA_EMBEDDING_MODEL"
  | "AI_TIMEOUT_MS"
>;

export interface ProviderDeps {
  geminiClient?: GeminiClientLike;
  fetchImpl?: typeof fetch;
  warn?: (message: string) => void;
}

/** Builds the provider selected by the validated `AI_PROVIDER`. Throws `ProviderConfigError` instead of degrading. */
export function createProvider(env: ProviderEnv, deps: ProviderDeps = {}): AiProvider {
  const kind: string = env.AI_PROVIDER;
  switch (kind) {
    case "mock":
      (deps.warn ?? console.warn)("[ai] AI_PROVIDER=mock: deterministic TEST DOUBLE in use. Results are NOT real AI.");
      return createMockProvider();
    case "gemini": {
      if (!env.GEMINI_API_KEY) throw new ProviderConfigError("GEMINI_API_KEY is required when AI_PROVIDER=gemini");
      return createGeminiProvider({
        apiKey: env.GEMINI_API_KEY,
        visionModel: env.GEMINI_VISION_MODEL,
        timeoutMs: env.AI_TIMEOUT_MS,
        ...(deps.geminiClient ? { client: deps.geminiClient } : {}),
      });
    }
    case "ollama":
      return createOllamaProvider({
        baseUrl: env.OLLAMA_BASE_URL,
        visionModel: env.OLLAMA_VISION_MODEL,
        embeddingModel: env.OLLAMA_EMBEDDING_MODEL,
        timeoutMs: env.AI_TIMEOUT_MS,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      });
    default:
      throw new ProviderConfigError(`Unsupported AI_PROVIDER "${kind}" (expected mock, gemini or ollama)`);
  }
}

/** Safe-to-log description: provider and model names only. */
export function describeProvider(p: AiProvider): string {
  return `${p.name} (vision=${p.visionModel}, embedding=${p.embeddingModel})`;
}
