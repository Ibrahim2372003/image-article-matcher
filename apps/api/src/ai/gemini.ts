import { GoogleGenAI } from "@google/genai";
import { EMBEDDING_DIMENSION, EMBEDDING_MODEL, EMBEDDING_TASK_TYPE } from "@iam/shared";
import {
  AiProviderError,
  ProviderConfigError,
  ProviderOutputError,
  ProviderRequestError,
  ProviderTimeoutError,
  scrubSecrets,
} from "./errors.js";
import { CLASSIFICATION_JSON_SCHEMA, CLASSIFY_PROMPT, type AiProvider, type ProviderUsage } from "./types.js";

/** The slice of the official `@google/genai` client this provider uses (structurally typed so tests can fake it). */
export interface GeminiClientLike {
  models: {
    generateContent(params: { model: string; contents: unknown; config?: Record<string, unknown> }): Promise<{
      text?: string;
      promptFeedback?: { blockReason?: string };
      candidates?: Array<{ finishReason?: string }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    }>;
    embedContent(params: {
      model: string;
      contents: unknown;
      config?: Record<string, unknown>;
    }): Promise<{ embeddings?: Array<{ values?: number[] }>; usageMetadata?: { promptTokenCount?: number } }>;
  };
}

export interface GeminiProviderOptions {
  apiKey: string;
  visionModel: string;
  embeddingModel?: string;
  /** Requested output size. Sent explicitly because gemini-embedding-001 defaults to 3072 dimensions. */
  dimension?: number;
  timeoutMs?: number;
  client?: GeminiClientLike;
}

/** Scales a vector to unit length. Does not change its length. */
export function l2Normalize(values: number[]): number[] {
  let sumSq = 0;
  for (const v of values) sumSq += v * v;
  const norm = Math.sqrt(sumSq);
  if (!Number.isFinite(norm) || norm === 0) return values; // leave bad data for schema validation to reject
  return values.map((v) => v / norm);
}

function usageOf(
  meta: { promptTokenCount?: number; candidatesTokenCount?: number } | undefined,
  fallbackIn: number | null,
): ProviderUsage {
  const reported = typeof meta?.promptTokenCount === "number";
  return {
    inputTokens: reported ? (meta?.promptTokenCount ?? null) : fallbackIn,
    outputTokens: typeof meta?.candidatesTokenCount === "number" ? meta.candidatesTokenCount : null,
    estimated: !reported,
  };
}

export function createGeminiProvider(options: GeminiProviderOptions): AiProvider {
  const { apiKey, visionModel } = options;
  if (!apiKey) throw new ProviderConfigError("GEMINI_API_KEY is required for the gemini provider");
  const embeddingModel = options.embeddingModel ?? EMBEDDING_MODEL;
  const dimension = options.dimension ?? EMBEDDING_DIMENSION;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const client: GeminiClientLike = options.client ?? (new GoogleGenAI({ apiKey }) as unknown as GeminiClientLike);

  /** Runs one SDK call with a hard timeout and maps every failure to a typed, secret-free error. */
  async function call<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ProviderTimeoutError(timeoutMs));
      }, timeoutMs);
    });
    try {
      // Raced against the deadline so a client that ignores the abort signal still cannot hang the caller.
      return await Promise.race([fn(controller.signal), deadline]);
    } catch (err) {
      if (err instanceof AiProviderError) throw err;
      const status =
        typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : null;
      const raw = err instanceof Error ? err.message : "unknown error";
      const detail = scrubSecrets(raw, [apiKey]).slice(0, 300);
      throw new ProviderRequestError(`Gemini request failed${status ? ` (HTTP ${status})` : ""}: ${detail}`, {
        status,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: "gemini",
    visionModel,
    embeddingModel,

    async classifyImage({ base64, mimeType }) {
      const response = await call((signal) =>
        client.models.generateContent({
          model: visionModel,
          contents: [{ role: "user", parts: [{ text: CLASSIFY_PROMPT }, { inlineData: { mimeType, data: base64 } }] }],
          config: {
            temperature: 0,
            responseMimeType: "application/json",
            responseJsonSchema: CLASSIFICATION_JSON_SCHEMA,
            abortSignal: signal,
          },
        }),
      );
      const usage = usageOf(response.usageMetadata, null);
      const blocked = response.promptFeedback?.blockReason;
      if (blocked) {
        throw new ProviderRequestError(`Gemini blocked the request: ${blocked}`, { retryable: false, usage });
      }
      const text = response.text;
      if (typeof text !== "string" || text.length === 0) {
        const reason = response.candidates?.[0]?.finishReason;
        throw new ProviderOutputError(`Gemini returned no text${reason ? ` (finishReason=${reason})` : ""}`, { usage });
      }
      let rawOutput: unknown;
      try {
        rawOutput = JSON.parse(text);
      } catch {
        throw new ProviderOutputError("Gemini returned non-JSON text for a JSON-mode request", { usage });
      }
      return { rawOutput, usage, model: visionModel };
    },

    async embedText(text, opts) {
      const response = await call((signal) =>
        client.models.embedContent({
          model: embeddingModel,
          contents: text,
          config: {
            taskType: opts?.taskType ?? EMBEDDING_TASK_TYPE,
            outputDimensionality: dimension,
            abortSignal: signal,
          },
        }),
      );
      const values = response.embeddings?.[0]?.values;
      if (!Array.isArray(values))
        throw new ProviderOutputError("Gemini embedding response had no embeddings[0].values array");
      // Google documents that gemini-embedding-001 only pre-normalizes the full 3072-dim output; any
      // reduced size must be L2-normalized by the caller. Length is NEVER altered here: a vector of the
      // wrong size is returned as-is so schema validation rejects it.
      return {
        vector: l2Normalize(values),
        usage: usageOf(response.usageMetadata, Math.ceil(text.length / 4)),
        model: embeddingModel,
      };
    },
  };
}
