import { ProviderError } from "./errors.js";
import { EMBEDDING_DIMENSION } from "../config.js";

/**
 * TEST DOUBLE — NOT REAL AI. Everything in this file exists so the
 * pipeline, the job worker, the Mismatch Guard, and the evaluation
 * infrastructure can run deterministically with no network. Results
 * produced through it must never be presented as Gemini results.
 */

const STOPWORDS = new Set(
  "the and for with that this from are was were has have had not but you your its their into over than then them these those about also more most can will who what when where how why tags category a an of in on to is it as at by be or".split(" ")
);

export function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token))
    .map((token) => (token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token));
}

function fnv1a(str, seed = 2166136261) {
  let hash = seed >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/**
 * A deterministic bag-of-words "embedding" (feature hashing into
 * `dimension` buckets, L2-normalised). It captures LEXICAL overlap only
 * — texts sharing words score as similar — which is a crude proxy for
 * semantic similarity and nothing like a real embedding model.
 */
export function lexicalHashEmbed(text, dimension = EMBEDDING_DIMENSION) {
  const vector = new Array(dimension).fill(0);
  for (const token of tokenize(text)) {
    const index = fnv1a(token) % dimension;
    const sign = fnv1a(token, 0x9747b28c) & 1 ? 1 : -1;
    vector[index] += sign;
  }
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  if (norm === 0) {
    vector[0] = 1;
    return vector;
  }
  return vector.map((x) => x / norm);
}

function basename(p) {
  return String(p).split("/").pop();
}

export function createMockProvider({
  classifications = {},
  classify = null,
  dimension = EMBEDDING_DIMENSION,
  embedFn = lexicalHashEmbed,
} = {}) {
  const calls = [];
  const queuedFailures = [];

  function maybeFail(operation) {
    const index = queuedFailures.findIndex((f) => f.operation === null || f.operation === operation);
    if (index === -1) return;
    const failure = queuedFailures[index];
    failure.remaining -= 1;
    if (failure.remaining <= 0) queuedFailures.splice(index, 1);
    throw failure.makeError();
  }

  return {
    name: "mock",
    visionModel: "mock-vision",
    embeddingModel: "mock-lexical-hash",
    calls,

    /** Make the next `count` calls (optionally only of one operation) throw. */
    failNext(count, makeError = () => new ProviderError("mock provider: injected failure", { retryable: true }), operation = null) {
      queuedFailures.push({ remaining: count, makeError, operation });
    },

    async classifyImage(input) {
      calls.push({ operation: "vision_classify", imagePath: input.imagePath });
      maybeFail("vision_classify");
      const fixture = classify ? classify(input) : classifications[input.imagePath] ?? classifications[basename(input.imagePath)];
      if (!fixture) {
        throw new ProviderError(`mock provider: no classification fixture for ${input.imagePath}`, { retryable: false });
      }
      const rawOutput = structuredClone(fixture);
      return {
        rawOutput,
        usage: { inputTokens: 258, outputTokens: Math.ceil(JSON.stringify(rawOutput).length / 4), estimated: true },
        model: "mock-vision",
      };
    },

    async embedText(text) {
      calls.push({ operation: "embed", chars: text.length });
      maybeFail("embed");
      return {
        vector: embedFn(text, dimension),
        usage: { inputTokens: Math.ceil(text.length / 4), outputTokens: 0, estimated: true },
        model: "mock-lexical-hash",
      };
    },
  };
}
