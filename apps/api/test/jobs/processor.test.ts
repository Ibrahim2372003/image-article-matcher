import { describe, expect, it, vi } from "vitest";
import {
  createMockProvider,
  InvalidEmbeddingError,
  ProviderRequestError,
  ProviderTimeoutError,
} from "../../src/ai/index.js";
import { processJob, type ProcessorDeps } from "../../src/jobs/processor.js";
import { resolveGuardConfig } from "../../src/matching/index.js";
import { FakeStore } from "../matching/fakeStore.js";
import { FakeJobStore } from "./fakeJobStore.js";

const FOREST = { category: "nature", tags: ["forest", "river", "trees"], confidence: 0.9 };
const loadImage = async () => ({ base64: "aGVsbG8=", mimeType: "image/png" as const });

function setup(
  opts: { maxAttempts?: number; classification?: typeof FOREST; pricing?: ProcessorDeps["pricing"] } = {},
) {
  const matches = new FakeStore();
  matches.addImage("i1", "forest.png");
  matches.articles.set("a1", {
    id: "a1",
    title: "Forest river hike",
    body: "Forest river trees hiking trail along the river among tall trees and forest.",
    category: "nature",
    tags: ["forest"],
  });
  const jobs = new FakeJobStore();
  const job = jobs.seed({ imageId: "i1", articleId: "a1", maxAttempts: opts.maxAttempts ?? 3 });
  const provider = createMockProvider({ classifications: { "forest.png": opts.classification ?? FOREST } });
  const logs: string[] = [];
  const deps: ProcessorDeps = {
    jobs,
    matches,
    provider,
    loadImage,
    guardConfig: resolveGuardConfig({ minSimilarity: 0.1, minMargin: 0 }),
    pricing: opts.pricing ?? {},
    log: (_l, msg) => logs.push(msg),
  };
  return { matches, jobs, job, provider, deps, logs };
}

describe("processJob: success paths", () => {
  it("runs claim -> classify -> embed -> embed -> pair evaluation -> one guarded commit", async () => {
    const { jobs, job, deps } = setup();
    const out = await processJob(job.id, deps);
    expect(out).toMatchObject({ kind: "completed", status: "completed", decision: "accept", aiCalls: 3 });
    const row = jobs.rows.get(job.id)!;
    expect(row).toMatchObject({ status: "completed", attempts: 1, decision: "accept" });
    expect(row.result).toMatchObject({ policyVersion: "guard-v1", embeddingModel: "mock-lexical-hash" });
    expect(row.result?.signals).toMatchObject({ rank: 1, embeddingTaskType: "SEMANTIC_SIMILARITY" });
    expect(jobs.events.map((e) => e.type)).toEqual(["job_claimed", "job_completed"]);
    expect(jobs.usage.map((u) => u.operation)).toEqual(["classify_image", "embed_image", "embed_article"]);
    expect(jobs.usage.every((u) => u.attempt === 1 && u.success)).toBe(true);
  });

  it("a review decision becomes status needs_review", async () => {
    const { jobs, job, deps } = setup({ classification: { ...FOREST, confidence: 0.2 } });
    const out = await processJob(job.id, deps);
    expect(out).toMatchObject({ kind: "completed", status: "needs_review", decision: "review" });
    expect(jobs.rows.get(job.id)).toMatchObject({ status: "needs_review", decision: "review" });
  });

  it("never invents cost: with no configured rate every usage row is cost-unknown, not zero", async () => {
    const { jobs, job, deps } = setup();
    await processJob(job.id, deps);
    for (const u of jobs.usage) expect(u).toMatchObject({ estimatedCostUsd: null, costBasis: "no_rate_configured" });
    expect((await jobs.getJobView(job.id))!.usage).toMatchObject({ estimatedCostUsd: null, costComplete: false });
  });

  it("a failing usage ledger does not fail the job or discard the result", async () => {
    const { jobs, job, deps } = setup();
    jobs.failures.recordUsage = true;
    expect((await processJob(job.id, deps)).kind).toBe("completed");
  });
});

describe("processJob: AI and infrastructure failures are NEVER content decisions", () => {
  it("a permanent failure (wrong embedding dimension) fails on the FIRST attempt without consuming the retry budget", async () => {
    const { jobs, job, provider, deps } = setup({ maxAttempts: 5 });
    const bad = createMockProvider({
      classifications: { "forest.png": FOREST },
      embedFn: () => new Array(1024).fill(0.1),
    });
    void provider;
    const out = await processJob(job.id, { ...deps, provider: bad });
    expect(out).toMatchObject({
      kind: "failed",
      attempt: 1,
      failure: { code: "provider_invalid_embedding", retryable: false },
    });
    const row = jobs.rows.get(job.id)!;
    expect(row).toMatchObject({
      status: "failed",
      attempts: 1,
      decision: null,
      errorCode: "provider_invalid_embedding",
    });
    expect(row.result).toBeNull();
    expect(jobs.events.map((e) => e.type)).toEqual(["job_claimed", "job_failed"]);
  });

  it.each([
    ["unsupported provider config", () => new ProviderRequestError("auth", { status: 401 }), "provider_request"],
    ["invalid embedding", () => new InvalidEmbeddingError("x", null), "provider_invalid_embedding"],
  ])("permanent error (%s) -> failed, decision stays null", async (_n, make, code) => {
    const { jobs, job, provider, deps } = setup();
    provider.failNext(1, make);
    const out = await processJob(job.id, deps);
    expect(out.kind).toBe("failed");
    expect(jobs.rows.get(job.id)).toMatchObject({ status: "failed", decision: null, errorCode: code });
  });

  it("a transient failure schedules a retry (status queued, error recorded, NO decision), then the next attempt succeeds and reuses finished steps", async () => {
    const { jobs, job, provider, deps } = setup();
    provider.failNext(1, () => new ProviderTimeoutError(1000), "embed"); // classification succeeds, first embedding times out
    const first = await processJob(job.id, deps);
    expect(first).toMatchObject({ kind: "retry", attempt: 1, failure: { code: "provider_timeout", retryable: true } });
    expect(jobs.rows.get(job.id)).toMatchObject({
      status: "queued",
      attempts: 1,
      decision: null,
      errorCode: "provider_timeout",
    });

    const second = await processJob(job.id, deps);
    expect(second).toMatchObject({ kind: "completed", decision: "accept" });
    expect(jobs.rows.get(job.id)).toMatchObject({ status: "completed", attempts: 2, errorCode: null });

    // ledger: attempt 1 = classify ok + embed FAILED; attempt 2 = embed_image + embed_article only (classification reused, no new call)
    expect(jobs.usage.map((u) => `${u.attempt}:${u.operation}:${u.success ? "ok" : u.errorCode}`)).toEqual([
      "1:classify_image:ok",
      "1:embed_image:provider_timeout",
      "2:embed_image:ok",
      "2:embed_article:ok",
    ]);
    expect(jobs.events.map((e) => e.type)).toEqual(["job_claimed", "retry_scheduled", "job_claimed", "job_completed"]);
  });

  it("retry budget is bounded: the last allowed attempt fails permanently (exhausted) instead of retrying again", async () => {
    const { jobs, job, provider, deps } = setup({ maxAttempts: 2 });
    provider.failNext(10, () => new ProviderTimeoutError(1000));
    expect((await processJob(job.id, deps)).kind).toBe("retry");
    const last = await processJob(job.id, deps);
    expect(last).toMatchObject({ kind: "failed", attempt: 2, failure: { code: "provider_timeout" } });
    expect(jobs.rows.get(job.id)).toMatchObject({
      status: "failed",
      attempts: 2,
      decision: null,
      errorCode: "provider_timeout",
    });
    expect(await processJob(job.id, deps)).toEqual({ kind: "skipped", reason: "terminal" }); // and it stays terminal
  });

  it("a job can never be produced as accept/reject/review after failing", async () => {
    const { jobs, job, provider, deps } = setup({ maxAttempts: 1 });
    provider.failNext(10, () => new ProviderRequestError("down", { status: 503 }));
    await processJob(job.id, deps);
    const v = await jobs.getJobView(job.id);
    expect(v).toMatchObject({ status: "failed", decision: null, reasons: [], similarity: null });
  });

  it("if the image and article embeddings come out in DIFFERENT spaces they are never compared: permanent matching failure", async () => {
    const { jobs, job, provider, deps } = setup();
    let n = 0;
    const embed = provider.embedText.bind(provider);
    provider.embedText = async (text, o) => ({ ...(await embed(text, o)), model: n++ === 0 ? "model-a" : "model-b" }); // image vs article
    const out = await processJob(job.id, deps);
    expect(out).toMatchObject({
      kind: "failed",
      failure: { code: "matching_incompatible_embedding_model", retryable: false },
    });
    expect(jobs.rows.get(job.id)).toMatchObject({ status: "failed", decision: null, attempts: 1 });
  });
});

describe("processJob: duplicate deliveries, crashes and stale workers", () => {
  it("a duplicate delivery of a TERMINAL job is a no-op and makes no AI calls", async () => {
    const { job, provider, deps } = setup();
    await processJob(job.id, deps);
    const calls = provider.calls.length;
    expect(await processJob(job.id, deps)).toEqual({ kind: "skipped", reason: "terminal" });
    expect(provider.calls.length).toBe(calls);
  });

  it("an unknown job id is dropped without retrying", async () => {
    const { deps } = setup();
    expect(await processJob("00000000-0000-4000-8000-000000000000", deps)).toEqual({
      kind: "skipped",
      reason: "missing",
    });
  });

  it("recovers from a worker crash: a job left in `processing` is re-claimed with the next attempt number", async () => {
    const { jobs, job, deps } = setup();
    await jobs.claim(job.id); // a worker claimed it and died
    expect(jobs.rows.get(job.id)?.status).toBe("processing");
    const out = await processJob(job.id, deps);
    expect(out.kind).toBe("completed");
    expect(jobs.rows.get(job.id)?.attempts).toBe(2);
  });

  it("crash loops cannot run forever: when all attempts were consumed the job FAILS at claim time", async () => {
    const { jobs, job, deps } = setup({ maxAttempts: 2 });
    await jobs.claim(job.id);
    await jobs.claim(job.id); // two crashed workers
    const out = await processJob(job.id, deps);
    expect(out).toMatchObject({ kind: "failed", failure: { code: "attempts_exceeded" } });
    expect(jobs.rows.get(job.id)).toMatchObject({ status: "failed", decision: null });
  });

  it("STALE WORKER: if a newer attempt took over mid-flight, the older result is discarded and cannot overwrite it", async () => {
    const { jobs, job, provider, deps } = setup();
    const original = provider.classifyImage.bind(provider);
    provider.classifyImage = async (input) => {
      await jobs.claim(job.id); // another worker re-claims while this one is still working
      return original(input);
    };
    const out = await processJob(job.id, deps);
    expect(out).toEqual({ kind: "superseded" });
    expect(jobs.rows.get(job.id)).toMatchObject({ status: "processing", attempts: 2, decision: null });
  });

  it("if persisting a RETRY fails (database down) the error propagates so the queue redelivers; state is not corrupted", async () => {
    const { jobs, job, provider, deps } = setup();
    provider.failNext(1, () => new ProviderTimeoutError(1000));
    jobs.failures.recordRetry = true;
    await expect(processJob(job.id, deps)).rejects.toThrow("db down");
    expect(jobs.rows.get(job.id)).toMatchObject({ status: "processing", decision: null });
    jobs.failures.recordRetry = false;
    expect((await processJob(job.id, deps)).kind).toBe("completed"); // the redelivery recovers
  });

  it("if committing the RESULT fails with a transient DB error it is retried, never recorded as a decision", async () => {
    const { jobs, job, deps } = setup();
    jobs.failures.commitResult = true;
    const out = await processJob(job.id, deps);
    expect(out).toMatchObject({ kind: "retry", failure: { code: "db_unavailable", retryable: true } });
    expect(jobs.rows.get(job.id)).toMatchObject({ status: "queued", decision: null });
  });

  it("the usage ledger records the failed call even when the job ultimately fails", async () => {
    const { jobs, job, provider, deps } = setup({ maxAttempts: 1 });
    provider.failNext(1, () => new ProviderRequestError("bad", { status: 400 }), "classify");
    await processJob(job.id, deps);
    expect(jobs.usage).toHaveLength(1);
    expect(jobs.usage[0]).toMatchObject({ operation: "classify_image", success: false, errorCode: "provider_request" });
  });
});

describe("processJob: logging hygiene", () => {
  it("logs ids and codes only", async () => {
    const { job, provider, deps, logs } = setup({ maxAttempts: 1 });
    provider.failNext(1, () => new ProviderRequestError("secret-api-key-xyz", { status: 500 }));
    const spy = vi.fn(deps.log);
    await processJob(job.id, { ...deps, log: spy });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret-api-key-xyz");
    expect(logs).toBeDefined();
  });
});
