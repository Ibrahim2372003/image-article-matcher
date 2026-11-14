# AI provider layer (milestone 3)

Code: `apps/api/src/ai/`. Select a provider with `AI_PROVIDER=mock|gemini|ollama` (validated in `env.ts`).

## Contract

`AiProvider` (`types.ts`) exposes `classifyImage({ base64, mimeType, imageRef? })` and `embedText(text, { taskType? })`. Providers do I/O and return **raw, unvalidated** output (`unknown`) plus token usage and the model name. They never validate and never decide.

`service.ts` is the only place output becomes trusted:

- `classifyImageValidated` parses with `VisionClassificationSchema` (strict: extra fields rejected).
- `embedTextValidated` parses with `EmbeddingVectorSchema` (exactly 768 finite numbers).
- Vectors are **never** padded or truncated. A wrong-size vector is an `InvalidEmbeddingError`.

Failures are exceptions (`errors.ts`), never return values, so an AI failure cannot be mistaken for an approval. Each has `retryable` for the future job worker:

| Error                       | Meaning                                                | Retryable |
| --------------------------- | ------------------------------------------------------ | --------- |
| `ProviderConfigError`       | missing/invalid configuration, unsupported provider    | no        |
| `ProviderInputError`        | bad mime type, non-base64 image, empty text            | no        |
| `ProviderRequestError`      | HTTP/API/network failure, safety block                 | by status (408/425/429/5xx yes; 4xx no) |
| `ProviderTimeoutError`      | no answer within `AI_TIMEOUT_MS`                       | yes       |
| `ProviderOutputError`       | response unusable (no text, not JSON, no vector)       | yes       |
| `InvalidClassificationError`| JSON failed the schema                                 | yes       |
| `InvalidEmbeddingError`     | wrong dimension / non-finite / non-numeric             | no        |

Security: API keys are redacted from SDK error text; error messages never contain image bytes or raw model output (it is untrusted and may echo injected instructions); the classification prompt tells the model to treat text inside the image as content, not instructions.

## Providers

**mock** (default): deterministic, offline, no secrets. A TEST DOUBLE: embeddings are lexical feature-hashes and the fallback classification is derived from a hash of the image bytes. Never present its output as real AI. Supports fixtures and failure injection for tests.

**gemini**: official `@google/genai` SDK. Vision model from `GEMINI_VISION_MODEL`; JSON-schema constrained, temperature 0. Embeddings use `gemini-embedding-001` with `outputDimensionality: 768` sent explicitly, because the model's default is 3072 dimensions. Google documents that only the 3072-dim output is pre-normalized, so the provider L2-normalizes the 768-dim vector (scaling only, length unchanged). Newer `gemini-embedding-2` exists but is not used; changing the embedding model requires re-embedding all stored vectors.

**ollama**: plain `fetch` to `OLLAMA_BASE_URL` (`/api/chat` with base64 image and JSON-schema `format`; `/api/embed`). Needs a vision-capable chat model and an embedding model that natively returns **768** dimensions (default `nomic-embed-text`). Models producing other sizes (e.g. 1024) are rejected. Pull models first: `ollama pull llama3.2-vision` and `ollama pull nomic-embed-text`. Default model names are suggestions and are not validated against a live server.

## Limits and cautions

- Image and article embeddings must come from the **same** embedding model/provider to be comparable. Each stored row records `embedding_model`; do not mix providers (milestone 4 must enforce this).
- Embedding input limit for `gemini-embedding-001` is about 2,048 tokens; the caller must truncate long articles.
- Embeddings are produced from text (image metadata or article text), not from image pixels.
- Timeouts are enforced per call; retries/backoff are the job worker's job (milestone 5).
