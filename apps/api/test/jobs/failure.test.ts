import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  InvalidClassificationError,
  InvalidEmbeddingError,
  ProviderConfigError,
  ProviderInputError,
  ProviderOutputError,
  ProviderRequestError,
  ProviderTimeoutError,
} from "../../src/ai/errors.js";
import { classifyError, sanitizeMessage } from "../../src/jobs/failure.js";
import {
  GuardInputError,
  ImageNotFoundError,
  IncompatibleEmbeddingModelError,
  MissingPrerequisiteError,
} from "../../src/matching/errors.js";
import { ImageStorageError } from "../../src/storage/errors.js";

const pgError = (code: string, message = "boom") => Object.assign(new Error(message), { code, severity: "ERROR" });

describe("classifyError: retry only transient failures", () => {
  it.each([
    ["timeout", new ProviderTimeoutError(1000), "provider_timeout", true],
    ["429", new ProviderRequestError("rate", { status: 429 }), "provider_request", true],
    ["503", new ProviderRequestError("down", { status: 503 }), "provider_request", true],
    ["network (no status)", new ProviderRequestError("reset"), "provider_request", true],
    ["malformed output", new ProviderOutputError("no text"), "provider_malformed_output", true],
    [
      "schema-invalid classification",
      new InvalidClassificationError("bad", null),
      "provider_invalid_classification",
      true,
    ],
    ["401", new ProviderRequestError("auth", { status: 401 }), "provider_request", false],
    ["safety block", new ProviderRequestError("blocked", { retryable: false }), "provider_request", false],
    ["config", new ProviderConfigError("no key"), "provider_config", false],
    ["input", new ProviderInputError("bad mime"), "provider_input", false],
    [
      "invalid embedding (wrong dimension)",
      new InvalidEmbeddingError("1024 values", null),
      "provider_invalid_embedding",
      false,
    ],
  ])("AI: %s", (_n, err, code, retryable) => {
    expect(classifyError(err)).toMatchObject({ code, retryable });
  });

  it.each([
    ["missing prerequisite", new MissingPrerequisiteError("classification", "x"), "matching_missing_prerequisite"],
    [
      "incompatible model",
      new IncompatibleEmbeddingModelError("a/b", ["c/d"], "image"),
      "matching_incompatible_embedding_model",
    ],
    ["image not found", new ImageNotFoundError("id"), "matching_image_not_found"],
    ["guard input", new GuardInputError("rank"), "matching_invalid_input"],
  ])("matching errors are permanent: %s", (_n, err, code) => {
    expect(classifyError(err)).toMatchObject({ code, retryable: false });
  });

  it.each(["not_found", "too_large", "unsupported_type", "invalid_path"] as const)(
    "image storage error %s is permanent",
    (c) => {
      expect(classifyError(new ImageStorageError(c, "x"))).toMatchObject({ code: `image_${c}`, retryable: false });
    },
  );

  it("a ZodError is a permanent invalid payload", () => {
    const r = z.object({ a: z.string() }).safeParse({});
    expect(r.success).toBe(false);
    if (!r.success) expect(classifyError(r.error)).toMatchObject({ code: "invalid_job_payload", retryable: false });
  });

  it.each([
    ["unique violation", "23505", "db_constraint", false],
    ["check violation", "23514", "db_constraint", false],
    ["invalid text representation", "22P02", "db_constraint", false],
    ["syntax error", "42601", "db_constraint", false],
    ["serialization failure", "40001", "db_unavailable", true],
    ["deadlock", "40P01", "db_unavailable", true],
    ["connection failure", "08006", "db_unavailable", true],
    ["admin shutdown", "57P01", "db_unavailable", true],
  ])("PostgreSQL %s (%s)", (_n, code, expected, retryable) => {
    expect(classifyError(pgError(code))).toMatchObject({ code: expected, retryable });
  });

  it("transient network errors are retryable", () => {
    for (const code of ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN"]) {
      expect(classifyError(Object.assign(new Error("x"), { code }))).toMatchObject({
        code: "network_error",
        retryable: true,
      });
    }
  });

  it("unknown errors are retryable (bounded by the attempt limit) and reveal no internals", () => {
    for (const e of [new Error("secret internal detail"), "string", null, undefined, 42, { weird: true }]) {
      const f = classifyError(e);
      expect(f).toMatchObject({ code: "internal_error", retryable: true });
      expect(f.message).toBe("unexpected internal error");
    }
  });

  it("a Postgres-looking code without the DatabaseError shape is NOT treated as a SQL error", () => {
    expect(classifyError(Object.assign(new Error("x"), { code: "23505" })).code).toBe("internal_error");
  });
});

describe("sanitizeMessage", () => {
  it("masks URLs that may carry credentials", () => {
    const m = sanitizeMessage("connect failed for postgres://app:hunter2@db:5432/x and redis://:pw@h:6379");
    expect(m).not.toContain("hunter2");
    expect(m).not.toContain(":pw@");
    expect(m).toContain("[redacted-url]");
  });
  it("strips control characters and bounds length", () => {
    expect(sanitizeMessage("a\nb\u0000c\u001bd")).toBe("a b c d");
    expect(sanitizeMessage("x".repeat(5000))).toHaveLength(500);
  });
  it("classifyError never leaks a database URL from a provider error message", () => {
    const f = classifyError(new ProviderRequestError("fail postgres://u:SECRETPW@h/db", { status: 500 }));
    expect(f.message).not.toContain("SECRETPW");
  });
});
