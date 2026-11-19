import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/env.js";

describe("loadEnv", () => {
  it("applies defaults", () => {
    const env = loadEnv({});
    expect(env.PORT).toBe(3000);
    expect(env.AI_PROVIDER).toBe("mock");
  });
  it("requires GEMINI_API_KEY for the gemini provider", () => {
    expect(() => loadEnv({ AI_PROVIDER: "gemini" })).toThrow(/GEMINI_API_KEY/);
  });
  it("rejects invalid values without echoing them", () => {
    expect(() => loadEnv({ PORT: "99999", API_KEY: "short" })).toThrow(/Invalid environment configuration/);
  });
});

describe("job and worker settings (milestone 5)", () => {
  it("have safe defaults", () => {
    const e = loadEnv({});
    expect(e).toMatchObject({
      JOB_MAX_ATTEMPTS: 3,
      WORKER_CONCURRENCY: 1,
      SHUTDOWN_TIMEOUT_MS: 60_000,
      QUEUE_PUBLISH_TIMEOUT_MS: 3_000,
      QUEUE_NAME: "image-article-analysis",
    });
    expect(e.JOB_BACKOFF_BASE_MS).toBeLessThanOrEqual(e.JOB_BACKOFF_MAX_MS);
  });
  it.each([
    { JOB_MAX_ATTEMPTS: "0" },
    { JOB_MAX_ATTEMPTS: "11" }, // the database CHECK allows at most 10
    { JOB_MAX_ATTEMPTS: "2.5" },
    { WORKER_CONCURRENCY: "0" },
    { WORKER_CONCURRENCY: "500" },
    { QUEUE_PUBLISH_TIMEOUT_MS: "5" },
    { SHUTDOWN_TIMEOUT_MS: "10" },
    { QUEUE_NAME: "bad:name" }, // BullMQ reserves ':'
    { QUEUE_NAME: "has space" },
    { RATE_LIMIT_MAX: "0" },
  ])("rejects %j", (bad) => {
    expect(() => loadEnv(bad)).toThrow(/Invalid environment/);
  });
  it("rejects a backoff cap below the base delay", () => {
    expect(() => loadEnv({ JOB_BACKOFF_BASE_MS: "10000", JOB_BACKOFF_MAX_MS: "5000" })).toThrow(/JOB_BACKOFF_MAX_MS/);
  });
  it("API_KEY must be long enough, and is mandatory in production", async () => {
    expect(() => loadEnv({ API_KEY: "short" })).toThrow(/Invalid environment/);
    const { assertApiKeyConfigured } = await import("../src/env.js");
    expect(() => assertApiKeyConfigured({ NODE_ENV: "production", API_KEY: undefined })).toThrow(/API_KEY is required/);
    expect(() => assertApiKeyConfigured({ NODE_ENV: "production", API_KEY: "x".repeat(16) })).not.toThrow();
    expect(() => assertApiKeyConfigured({ NODE_ENV: "development", API_KEY: undefined })).not.toThrow(); // the API fails closed with 503 instead
  });
});
