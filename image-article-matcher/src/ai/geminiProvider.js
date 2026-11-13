import { ProviderError } from "./errors.js";
import {
  GEMINI_API_BASE,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSION,
  EMBEDDING_TASK_TYPE,
  DEFAULT_VISION_MODEL,
} from "../config.js";

const CLASSIFY_PROMPT =
  "You are an image classifier for a blog image-matching system. Look at the image and return a JSON object with: " +
  "category (one short lowercase label for the main subject area, for example nature, architecture, food, technology, sports), " +
  "tags (3 to 8 short lowercase keywords describing what is visible), " +
  "confidence (a number from 0 to 1: how sure you are of the category). Return only the JSON object.";

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Real Gemini client over the REST API using plain fetch (no SDK — the
 * whole provider is one auditable file). `fetchImpl` is injectable so
 * tests can exercise request building, response parsing, and error
 * mapping without a network.
 *
 * NOT VERIFIED against the live API: Gemini was unreachable from the
 * environment this was built in (egress allowlist). The request and
 * response shapes below are written from Google's public documentation
 * and exercised in tests against FAKE responses shaped from that
 * documentation — which proves this file's own logic, not that the live
 * API behaves identically. See EVIDENCE.md.
 */
export function createGeminiProvider({
  apiKey,
  fetchImpl = globalThis.fetch,
  visionModel = DEFAULT_VISION_MODEL,
  embeddingModel = EMBEDDING_MODEL,
  dimension = EMBEDDING_DIMENSION,
  baseUrl = GEMINI_API_BASE,
  timeoutMs = 30000,
} = {}) {
  if (!apiKey) throw new Error("createGeminiProvider: apiKey is required");

  async function post(path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(`${baseUrl}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const reason = err?.name === "AbortError" ? "request timed out" : err?.message ?? "unknown network error";
      throw new ProviderError(`network error calling Gemini: ${reason}`, { retryable: true });
    } finally {
      clearTimeout(timer);
    }

    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (!res.ok) {
      const detail = data?.error?.message ?? `HTTP ${res.status}`;
      throw new ProviderError(`Gemini API error ${res.status}: ${detail}`, {
        retryable: isRetryableStatus(res.status),
        status: res.status,
      });
    }
    return data;
  }

  return {
    name: "gemini",
    visionModel,
    embeddingModel,

    async classifyImage({ base64, mimeType }) {
      const data = await post(`models/${visionModel}:generateContent`, {
        contents: [
          {
            role: "user",
            parts: [{ text: CLASSIFY_PROMPT }, { inlineData: { mimeType, data: base64 } }],
          },
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              category: { type: "STRING" },
              tags: { type: "ARRAY", items: { type: "STRING" } },
              confidence: { type: "NUMBER" },
            },
            required: ["category", "tags", "confidence"],
          },
        },
      });

      const usage = {
        inputTokens: data?.usageMetadata?.promptTokenCount ?? null,
        outputTokens: data?.usageMetadata?.candidatesTokenCount ?? null,
        estimated: false,
      };

      if (data?.promptFeedback?.blockReason) {
        throw new ProviderError(`Gemini blocked the request: ${data.promptFeedback.blockReason}`, { retryable: false, usage });
      }
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof text !== "string" || text.length === 0) {
        throw new ProviderError("Gemini returned no text candidate", { retryable: true, usage });
      }
      let rawOutput;
      try {
        rawOutput = JSON.parse(text);
      } catch {
        throw new ProviderError("Gemini returned non-JSON text for a JSON-mode request", { retryable: true, usage });
      }
      return { rawOutput, usage, model: visionModel };
    },

    async embedText(text, { taskType = EMBEDDING_TASK_TYPE } = {}) {
      const data = await post(`models/${embeddingModel}:embedContent`, {
        model: `models/${embeddingModel}`,
        content: { parts: [{ text }] },
        taskType,
        outputDimensionality: dimension,
      });

      const values = data?.embedding?.values;
      if (!Array.isArray(values)) {
        throw new ProviderError("Gemini embedding response had no embedding.values array", { retryable: true });
      }
      // The embedContent response is not documented to report token usage,
      // so when it is absent the count is a LOCAL ESTIMATE (chars / 4),
      // flagged as such all the way into model_calls.tokens_estimated.
      const reported = data?.usageMetadata?.promptTokenCount;
      const usage =
        typeof reported === "number"
          ? { inputTokens: reported, outputTokens: 0, estimated: false }
          : { inputTokens: Math.ceil(text.length / 4), outputTokens: 0, estimated: true };
      return { vector: values, usage, model: embeddingModel };
    },
  };
}
