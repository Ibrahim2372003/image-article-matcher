import { ProviderConfigError, ProviderOutputError, ProviderRequestError, ProviderTimeoutError } from "./errors.js";
import { CLASSIFICATION_JSON_SCHEMA, CLASSIFY_PROMPT, type AiProvider, type ProviderUsage } from "./types.js";

export interface OllamaProviderOptions {
  baseUrl: string;
  visionModel: string;
  embeddingModel: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Local provider over Ollama's REST API (`/api/chat` for vision, `/api/embed` for embeddings), using
 * plain `fetch` (no extra dependency). NOT verified against a live Ollama server in this repo's
 * evidence unless EVIDENCE.md says so.
 *
 * The embedding model must natively return 768 dimensions (e.g. `nomic-embed-text`). Vectors of any
 * other size are rejected by validation, never padded or truncated.
 */
export function createOllamaProvider(options: OllamaProviderOptions): AiProvider {
  let base: URL;
  try {
    base = new URL(options.baseUrl);
  } catch {
    throw new ProviderConfigError("OLLAMA_BASE_URL is not a valid URL");
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new ProviderConfigError("OLLAMA_BASE_URL must use http or https");
  }
  const root = base.toString().replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 30_000;
  const doFetch = options.fetchImpl ?? globalThis.fetch;

  async function postJson(path: string, body: unknown): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      let res: Response;
      try {
        res = await doFetch(`${root}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        if (timedOut) throw new ProviderTimeoutError(timeoutMs);
        const msg = err instanceof Error ? err.message : "unknown network error";
        throw new ProviderRequestError(`Ollama unreachable at ${base.host}: ${msg.slice(0, 200)}`, {
          retryable: true,
        });
      }
      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (!res.ok) {
        const detail =
          typeof (data as { error?: unknown } | null)?.error === "string"
            ? (data as { error: string }).error
            : `HTTP ${res.status}`;
        const hint = res.status === 404 ? " (is the model pulled? run `ollama pull <model>`)" : "";
        throw new ProviderRequestError(`Ollama API error ${res.status}: ${detail.slice(0, 200)}${hint}`, {
          status: res.status,
        });
      }
      if (typeof data !== "object" || data === null)
        throw new ProviderOutputError("Ollama returned a non-object JSON body");
      return data as Record<string, unknown>;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: "ollama",
    visionModel: options.visionModel,
    embeddingModel: options.embeddingModel,

    async classifyImage({ base64 }) {
      const data = await postJson("/api/chat", {
        model: options.visionModel,
        stream: false,
        format: CLASSIFICATION_JSON_SCHEMA,
        options: { temperature: 0 },
        messages: [{ role: "user", content: CLASSIFY_PROMPT, images: [base64] }],
      });
      const usage: ProviderUsage = {
        inputTokens: num(data.prompt_eval_count),
        outputTokens: num(data.eval_count),
        estimated: false,
      };
      const content = (data.message as { content?: unknown } | undefined)?.content;
      if (typeof content !== "string" || content.length === 0)
        throw new ProviderOutputError("Ollama returned no message content", { usage });
      let rawOutput: unknown;
      try {
        rawOutput = JSON.parse(content);
      } catch {
        throw new ProviderOutputError("Ollama returned non-JSON text for a JSON-format request", { usage });
      }
      return { rawOutput, usage, model: options.visionModel };
    },

    async embedText(text) {
      const data = await postJson("/api/embed", { model: options.embeddingModel, input: text });
      const first = Array.isArray(data.embeddings) ? (data.embeddings as unknown[])[0] : undefined;
      if (!Array.isArray(first)) throw new ProviderOutputError("Ollama embedding response had no embeddings[0] array");
      const reported = num(data.prompt_eval_count);
      return {
        vector: first,
        usage: { inputTokens: reported ?? Math.ceil(text.length / 4), outputTokens: 0, estimated: reported === null },
        model: options.embeddingModel,
      };
    },
  };
}
