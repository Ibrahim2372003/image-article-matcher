import { randomBytes } from "node:crypto";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockProvider, ProviderTimeoutError } from "../../src/ai/index.js";
import { processJob, type ProcessorDeps } from "../../src/jobs/processor.js";
import { createBullJobQueue, type JobQueue } from "../../src/jobs/queue.js";
import { createBullWorker, type BullWorker } from "../../src/jobs/worker.js";
import { resolveGuardConfig } from "../../src/matching/index.js";
import { FakeStore } from "../matching/fakeStore.js";
import { FakeJobStore } from "./fakeJobStore.js";

/**
 * REAL Redis + BullMQ. Skipped unless TEST_REDIS_URL is set (e.g. redis://localhost:6379). Each run uses its own
 * uniquely named queue and removes only that queue afterwards. The job store, matching store and AI provider are
 * in-memory fakes: this file verifies the QUEUE behaviour (delivery, retry/backoff, no retry of permanent failures,
 * duplicate delivery, finished-job re-publication), not the database.
 *
 * Run against the Docker Redis:  TEST_REDIS_URL=redis://localhost:6379 npm test -- apps/api/test/jobs/queue.integration
 * STATUS: written but NOT executed in the build sandbox (no Redis available there).
 */
const REDIS_URL = process.env.TEST_REDIS_URL;
const FOREST = { category: "nature", tags: ["forest", "river", "trees"], confidence: 0.9 };
const loadImage = async () => ({ base64: "aGVsbG8=", mimeType: "image/png" as const });
const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out waiting for condition");
};

describe.skipIf(!REDIS_URL)("BullMQ delivery on real Redis (unique queue per run)", () => {
  const name = `iam-it-${randomBytes(4).toString("hex")}`;
  let workerConn: Redis;
  let pubConn: Redis;
  let queue: JobQueue;
  let admin: Queue;
  let worker: BullWorker;
  let jobs: FakeJobStore;
  let matches: FakeStore;
  let provider: ReturnType<typeof createMockProvider>;

  beforeAll(async () => {
    workerConn = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
    pubConn = new Redis(REDIS_URL!, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
    admin = new Queue(name, { connection: new Redis(REDIS_URL!, { maxRetriesPerRequest: null }) as never });
    queue = createBullJobQueue({ connection: pubConn, name });
    jobs = new FakeJobStore();
    matches = new FakeStore();
    matches.addImage("i1", "forest.png");
    matches.articles.set("a1", {
      id: "a1",
      title: "Forest river hike",
      body: "Forest river trees hiking trail along the river among tall trees and forest.",
      category: "nature",
      tags: ["forest"],
    });
    provider = createMockProvider({ classifications: { "forest.png": FOREST } });
    const deps: ProcessorDeps = {
      jobs,
      matches,
      provider,
      loadImage,
      guardConfig: resolveGuardConfig({ minSimilarity: 0.1, minMargin: 0 }),
      pricing: {},
      log: () => {},
    };
    worker = createBullWorker({
      connection: workerConn,
      name,
      concurrency: 2,
      backoff: { baseMs: 100, maxMs: 500 },
      log: () => {},
      handler: (id) => processJob(id, deps),
    });
  });
  afterAll(async () => {
    await worker?.close();
    await queue?.close();
    await admin?.obliterate({ force: true }).catch(() => undefined); // only this run's uniquely named queue
    await admin?.close();
    workerConn?.disconnect();
    pubConn?.disconnect();
  });

  const publish = async (over: Parameters<FakeJobStore["seed"]>[0] = {}) => {
    const job = jobs.seed({ imageId: "i1", articleId: "a1", ...over });
    expect(await queue.ensureQueued({ id: job.id, maxAttempts: job.maxAttempts })).toBe("added");
    return job;
  };

  it("delivers a job id to the worker, which runs the pipeline and completes it", async () => {
    const job = await publish();
    await waitFor(() => jobs.rows.get(job.id)?.status === "completed");
    expect(jobs.rows.get(job.id)).toMatchObject({ status: "completed", attempts: 1, decision: "accept" });
    const bull = await admin.getJob(job.id);
    expect(bull?.data).toEqual({ jobId: job.id }); // ONLY the id travelled through Redis
  });

  it("re-publishing a LIVE job is a no-op (no duplicate delivery)", async () => {
    const before = jobs.events.length;
    const job = jobs.seed({ imageId: "i1", articleId: "a1" });
    // publish twice back to back; the second must see a live entry (or a finished one it replaces) but never run the job twice concurrently
    await Promise.all([
      queue.ensureQueued({ id: job.id, maxAttempts: 3 }),
      queue.ensureQueued({ id: job.id, maxAttempts: 3 }),
    ]);
    await waitFor(() => jobs.rows.get(job.id)?.status === "completed");
    expect(jobs.events.slice(before).filter((e) => e.jobId === job.id && e.type === "job_completed")).toHaveLength(1);
  });

  it("a transient failure is retried after the bounded backoff and then succeeds, reusing finished steps", async () => {
    provider.failNext(1, () => new ProviderTimeoutError(1000), "embed");
    const job = await publish();
    await waitFor(() => jobs.rows.get(job.id)?.status === "completed");
    expect(jobs.rows.get(job.id)?.attempts).toBe(2);
    expect(jobs.events.filter((e) => e.jobId === job.id).map((e) => e.type)).toEqual([
      "job_claimed",
      "retry_scheduled",
      "job_claimed",
      "job_completed",
    ]);
  });

  it("a PERMANENT failure is not retried by BullMQ: one attempt, status failed, no decision", async () => {
    const bad = createMockProvider({
      classifications: { "forest.png": FOREST },
      embedFn: () => new Array(1024).fill(0.1),
    });
    const deps: ProcessorDeps = {
      jobs,
      matches,
      provider: bad,
      loadImage,
      guardConfig: resolveGuardConfig(),
      pricing: {},
      log: () => {},
    };
    const name2 = `iam-it-${randomBytes(4).toString("hex")}`;
    const conn = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
    const w2 = createBullWorker({
      connection: conn,
      name: name2,
      concurrency: 1,
      backoff: { baseMs: 100, maxMs: 500 },
      log: () => {},
      handler: (id) => processJob(id, deps),
    });
    const pub2 = new Redis(REDIS_URL!, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
    const q2 = createBullJobQueue({ connection: pub2, name: name2 });
    const adm2 = new Queue(name2, { connection: new Redis(REDIS_URL!, { maxRetriesPerRequest: null }) as never });
    try {
      const job = jobs.seed({ imageId: "i1", articleId: "a1", maxAttempts: 5 });
      await q2.ensureQueued({ id: job.id, maxAttempts: 5 });
      await waitFor(() => jobs.rows.get(job.id)?.status === "failed");
      await new Promise((r) => setTimeout(r, 1500)); // a wrongly retried job would have run again by now
      expect(jobs.rows.get(job.id)).toMatchObject({ status: "failed", attempts: 1, decision: null });
      expect((await adm2.getJob(job.id))?.attemptsMade).toBe(1);
    } finally {
      await w2.close();
      await q2.close();
      await adm2.obliterate({ force: true }).catch(() => undefined);
      await adm2.close();
      conn.disconnect();
      pub2.disconnect();
    }
  });

  it("a finished BullMQ job is removed and re-added on re-publication; the delivery is then a harmless no-op for a terminal job", async () => {
    const job = await publish();
    await waitFor(() => jobs.rows.get(job.id)?.status === "completed");
    await waitFor(async () => (await admin.getJob(job.id).then((j) => j?.getState())) === "completed");
    const calls = provider.calls.length;
    expect(await queue.ensureQueued({ id: job.id, maxAttempts: 3 })).toBe("added"); // the leftover was replaced, not ignored
    await new Promise((r) => setTimeout(r, 1000));
    expect(jobs.rows.get(job.id)).toMatchObject({ status: "completed", attempts: 1 }); // not processed again
    expect(provider.calls.length).toBe(calls); // no AI call for a terminal job
  });

  it("ping() reports a healthy connection", async () => {
    expect(await queue.ping()).toBe(true);
  });
});
