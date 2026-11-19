import { ZodError } from "zod";
import { AiProviderError } from "../ai/errors.js";
import { MatchingError } from "../matching/errors.js";
import { ImageStorageError } from "../storage/errors.js";
import type { JobFailure } from "./types.js";

const MAX_MESSAGE = 500;
const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN"]);

/** Single line, no control characters, URLs (which may carry credentials) masked, length-bounded. */
export function sanitizeMessage(message: string): string {
  return (
    message
      .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, "[redacted-url]")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .trim()
      .slice(0, MAX_MESSAGE)
  );
}

const pgCode = (err: unknown): string | null => {
  if (typeof err !== "object" || err === null) return null;
  const code = (err as { code?: unknown }).code;
  // node-postgres DatabaseError: 5-character SQLSTATE plus a `severity` field.
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) && "severity" in err ? code : null;
};

/**
 * Maps any thrown value to a STABLE code and a retry decision. Only transient failures are retryable;
 * everything that retrying cannot fix fails immediately. Unknown errors are retryable but bounded by the
 * attempt limit, and never reveal internals (the code is `internal_error`).
 */
export function classifyError(err: unknown): JobFailure {
  if (err instanceof AiProviderError) {
    return { code: `provider_${err.code}`, retryable: err.retryable, message: sanitizeMessage(err.message) };
  }
  if (err instanceof MatchingError) {
    return { code: `matching_${err.code}`, retryable: false, message: sanitizeMessage(err.message) };
  }
  if (err instanceof ImageStorageError) {
    return { code: `image_${err.code}`, retryable: false, message: sanitizeMessage(err.message) };
  }
  if (err instanceof ZodError) {
    return {
      code: "invalid_job_payload",
      retryable: false,
      message: sanitizeMessage(err.issues.map((i) => i.message).join("; ")),
    };
  }
  const sqlstate = pgCode(err);
  if (sqlstate) {
    const cls = sqlstate.slice(0, 2);
    if (cls === "23" || cls === "22" || cls === "42") {
      return { code: "db_constraint", retryable: false, message: `database rejected the write (SQLSTATE ${sqlstate})` };
    }
    // 40001 serialization, 40P01 deadlock, 08xxx connection, 53xxx resources, 57P0x shutdown: transient.
    return { code: "db_unavailable", retryable: true, message: `transient database error (SQLSTATE ${sqlstate})` };
  }
  const nodeCode = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  if (typeof nodeCode === "string" && NETWORK_CODES.has(nodeCode)) {
    return { code: "network_error", retryable: true, message: `network error (${nodeCode})` };
  }
  return { code: "internal_error", retryable: true, message: "unexpected internal error" };
}
