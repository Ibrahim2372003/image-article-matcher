import type { ProviderUsage } from "./types.js";

export type AiErrorCode =
  "config" | "input" | "request" | "timeout" | "malformed_output" | "invalid_classification" | "invalid_embedding";

/**
 * Every AI failure is an exception, never a value. A failure can therefore never be mistaken for a
 * valid classification, and callers (job worker, Mismatch Guard) must handle it explicitly:
 * the guard turns it into `reject`/`review`, never `accept`.
 *
 * `retryable` tells the job worker whether a retry could plausibly help. Messages must never
 * contain API keys, credentials, or image bytes.
 */
export class AiProviderError extends Error {
  readonly code: AiErrorCode;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly usage: ProviderUsage | null;

  constructor(
    code: AiErrorCode,
    message: string,
    opts: { retryable: boolean; status?: number | null; usage?: ProviderUsage | null; cause?: unknown },
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = new.target.name;
    this.code = code;
    this.retryable = opts.retryable;
    this.status = opts.status ?? null;
    this.usage = opts.usage ?? null;
  }
}

/** Missing/invalid provider configuration. Retrying cannot fix it. */
export class ProviderConfigError extends AiProviderError {
  constructor(message: string) {
    super("config", message, { retryable: false });
  }
}

/** The caller supplied unusable input (bad mime type, empty image/text). Permanent. */
export class ProviderInputError extends AiProviderError {
  constructor(message: string) {
    super("input", message, { retryable: false });
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** HTTP/API-level failure (auth, quota, 5xx, safety block, network). */
export class ProviderRequestError extends AiProviderError {
  constructor(
    message: string,
    opts: { retryable?: boolean; status?: number | null; usage?: ProviderUsage | null; cause?: unknown } = {},
  ) {
    const status = opts.status ?? null;
    super("request", message, {
      retryable: opts.retryable ?? (status === null ? true : isRetryableStatus(status)),
      status,
      usage: opts.usage ?? null,
      cause: opts.cause,
    });
  }
}

export class ProviderTimeoutError extends AiProviderError {
  constructor(timeoutMs: number) {
    super("timeout", `AI provider request timed out after ${timeoutMs} ms`, { retryable: true });
  }
}

/** The provider answered but the response was not usable at all (no text, not JSON, no vector). */
export class ProviderOutputError extends AiProviderError {
  constructor(message: string, opts: { retryable?: boolean; usage?: ProviderUsage | null } = {}) {
    super("malformed_output", message, { retryable: opts.retryable ?? true, usage: opts.usage ?? null });
  }
}

/** Structured output failed schema validation. A later sample may be valid, so it is retryable. */
export class InvalidClassificationError extends AiProviderError {
  constructor(message: string, usage: ProviderUsage | null) {
    super("invalid_classification", message, { retryable: true, usage });
  }
}

/** Wrong dimension / non-finite / non-numeric vector. A model or configuration mismatch: not retryable. */
export class InvalidEmbeddingError extends AiProviderError {
  constructor(message: string, usage: ProviderUsage | null) {
    super("invalid_embedding", message, { retryable: false, usage });
  }
}

/** Replaces every occurrence of each secret in `message`. */
export function scrubSecrets(message: string, secrets: ReadonlyArray<string | undefined>): string {
  let out = message;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join("[redacted]");
  }
  return out;
}
