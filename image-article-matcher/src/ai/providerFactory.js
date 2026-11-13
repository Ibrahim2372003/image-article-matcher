import { createGeminiProvider } from "./geminiProvider.js";
import { createMockProvider } from "./mockProvider.js";
import { ProviderError } from "./errors.js";
import { DEFAULT_VISION_MODEL } from "../config.js";

/** Used when no API key is configured: every AI call fails permanently with a clear reason, instead of the app refusing to start. */
export function createUnconfiguredProvider(reason) {
  const fail = async () => {
    throw new ProviderError(reason, { retryable: false });
  };
  return { name: "gemini-unconfigured", visionModel: DEFAULT_VISION_MODEL, embeddingModel: "unconfigured", classifyImage: fail, embedText: fail };
}

export function buildProviderFromEnv(env = process.env, { mockClassifications = {} } = {}) {
  const kind = env.AI_PROVIDER ?? "gemini";
  if (kind === "mock") {
    console.warn("[ai] AI_PROVIDER=mock: deterministic TEST DOUBLE in use. Results are NOT real AI.");
    return createMockProvider({ classifications: mockClassifications });
  }
  if (kind === "gemini") {
    if (!env.GEMINI_API_KEY) {
      console.warn("[ai] GEMINI_API_KEY is not set: AI jobs will fail permanently until it is configured.");
      return createUnconfiguredProvider("GEMINI_API_KEY is not set");
    }
    return createGeminiProvider({ apiKey: env.GEMINI_API_KEY, visionModel: env.GEMINI_VISION_MODEL || DEFAULT_VISION_MODEL });
  }
  throw new Error(`Unknown AI_PROVIDER "${kind}" (expected "gemini" or "mock")`);
}
