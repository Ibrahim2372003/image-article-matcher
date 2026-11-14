import { createHash } from "node:crypto";
import { EMBEDDING_DIMENSION, type VisionClassification } from "@iam/shared";
import { ProviderRequestError, type AiProviderError } from "./errors.js";
import type { AiProvider, ClassifyImageInput, EmbedTextOptions, RawClassification, RawEmbedding } from "./types.js";

/**
 * TEST DOUBLE, NOT REAL AI. Deterministic and offline. Its "embedding" captures lexical overlap only
 * and its fallback classification is derived from a hash of the image bytes, so results must never be
 * presented as real model output. Provider name/model strings make that visible in stored rows.
 */

const STOPWORDS = new Set(
  "the and for with that this from are was were has have had not but you your its their into over than then them these those about also more most can will who what when where how why tags category".split(
    " ",
  ),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
    .map((t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t));
}

function fnv1a(str: string, seed = 2166136261): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Feature-hashed bag of words, L2-normalised. Deterministic. */
export function lexicalHashEmbed(text: string, dimension: number = EMBEDDING_DIMENSION): number[] {
  const v = new Array<number>(dimension).fill(0);
  for (const token of tokenize(text)) {
    const idx = fnv1a(token) % dimension;
    v[idx] = (v[idx] ?? 0) + (fnv1a(token, 0x9747b28c) & 1 ? 1 : -1);
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (norm === 0) {
    v[0] = 1;
    return v;
  }
  return v.map((x) => x / norm);
}

const FALLBACK_CATEGORIES = ["nature", "architecture", "food", "technology", "sports", "people"] as const;

export interface MockProviderOptions {
  /** Fixed classifications keyed by `imageRef` (or its basename). */
  classifications?: Record<string, VisionClassification>;
  /** Full override; may return malformed data on purpose to test validation. */
  classify?: (input: ClassifyImageInput) => unknown;
  dimension?: number;
  embedFn?: (text: string, dimension: number) => unknown;
}

export interface MockProvider extends AiProvider {
  /** Operation log. Holds sizes only, never image bytes. */
  readonly calls: Array<{ operation: "classify" | "embed"; imageRef?: string; chars?: number }>;
  failNext(count: number, makeError?: () => AiProviderError, operation?: "classify" | "embed"): void;
}

export function createMockProvider(opts: MockProviderOptions = {}): MockProvider {
  const dimension = opts.dimension ?? EMBEDDING_DIMENSION;
  const calls: MockProvider["calls"] = [];
  const failures: Array<{ remaining: number; make: () => AiProviderError; operation?: "classify" | "embed" }> = [];

  const maybeFail = (operation: "classify" | "embed"): void => {
    const i = failures.findIndex((f) => f.operation === undefined || f.operation === operation);
    const f = failures[i];
    if (!f) return;
    f.remaining -= 1;
    if (f.remaining <= 0) failures.splice(i, 1);
    throw f.make();
  };

  return {
    name: "mock",
    visionModel: "mock-vision",
    embeddingModel: "mock-lexical-hash",
    calls,
    failNext(
      count,
      make = () => new ProviderRequestError("mock provider: injected failure", { retryable: true }),
      operation,
    ) {
      failures.push({ remaining: count, make, operation });
    },

    async classifyImage(input): Promise<RawClassification> {
      calls.push({ operation: "classify", ...(input.imageRef ? { imageRef: input.imageRef } : {}) });
      maybeFail("classify");
      const ref = input.imageRef ?? "";
      const base = ref.split("/").pop() ?? "";
      const fixture = opts.classifications?.[ref] ?? opts.classifications?.[base];
      let rawOutput: unknown;
      if (opts.classify) rawOutput = opts.classify(input);
      else if (fixture) rawOutput = structuredClone(fixture);
      else {
        const digest = createHash("sha256").update(input.base64).digest();
        const category = FALLBACK_CATEGORIES[(digest[0] ?? 0) % FALLBACK_CATEGORIES.length] ?? "nature";
        rawOutput = { category, tags: ["mock", category], confidence: 0.5 };
      }
      return {
        rawOutput,
        usage: { inputTokens: 258, outputTokens: Math.ceil(JSON.stringify(rawOutput).length / 4), estimated: true },
        model: "mock-vision",
      };
    },

    async embedText(text: string, _options?: EmbedTextOptions): Promise<RawEmbedding> {
      calls.push({ operation: "embed", chars: text.length });
      maybeFail("embed");
      return {
        vector: (opts.embedFn ?? lexicalHashEmbed)(text, dimension),
        usage: { inputTokens: Math.ceil(text.length / 4), outputTokens: 0, estimated: true },
        model: "mock-lexical-hash",
      };
    },
  };
}
