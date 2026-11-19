import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { createMockProvider } from "../../src/ai/index.js";
import { IdempotencyConflictError, InvalidIdempotencyKeyError, QueueUnavailableError } from "../../src/jobs/errors.js";
import { processJob } from "../../src/jobs/processor.js";
import type { JobQueue } from "../../src/jobs/queue.js";
import { reconcileOnce } from "../../src/jobs/reconciler.js";
import { submitJob } from "../../src/jobs/submit.js";
import { ImageStore } from "../../src/storage/imageStore.js";
import { ImageStorageError } from "../../src/storage/errors.js";
import { resolveGuardConfig } from "../../src/matching/index.js";
import { FakeStore } from "../matching/fakeStore.js";
import { PNG, JPEG, GIF } from "../storage/fixtures.js";
import { FakeJobStore } from "./fakeJobStore.js";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "iam-submit-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup() {
  const jobs = new FakeJobStore();
  const state = { up: true, published: [] as string[] };
  const queue: JobQueue = {
    ensureQueued: async (j) => {
      if (!state.up) throw new Error("Connection is closed.");
      state.published.push(j.id);
      return "added";
    },
    ping: async () => state.up,
    close: async () => {},
  };
  const images = new ImageStore(path.join(dir, "images"), 100_000);
  return { jobs, queue, images, state, deps: { jobs, queue, images, maxAttempts: 3 } };
}
const article = {
  title: "River walk",
  body: "A walk by the river among the trees.",
  category: "nature",
  tags: ["river"],
};
const storedFiles = async (images: ImageStore) =>
  (await readdir(images.root).catch(() => [])).filter((n) => !n.startsWith("."));

describe("submitJob", () => {
  it("stores the image, writes the job, publishes it and marks it published", async () => {
    const { deps, jobs, state } = setup();
    const r = await submitJob(deps, { article, imageBytes: PNG });
    expect(r.replayed).toBe(false);
    expect(r.job.status).toBe("queued");
    expect(state.published).toEqual([r.job.id]);
    expect(jobs.enqueued).toEqual([r.job.id]);
    expect(await storedFiles(deps.images)).toHaveLength(1);
  });

  it("identical resubmission is a replay of the SAME job and is not published twice", async () => {
    const { deps, state } = setup();
    const a = await submitJob(deps, { article, imageBytes: PNG });
    const b = await submitJob(deps, { article: { ...article, title: "  River walk " }, imageBytes: Buffer.from(PNG) });
    expect(b).toMatchObject({ replayed: true });
    expect(b.job.id).toBe(a.job.id);
    expect(state.published).toHaveLength(1);
  });

  it("a different image or different article is a different job", async () => {
    const { deps } = setup();
    const a = await submitJob(deps, { article, imageBytes: PNG });
    const b = await submitJob(deps, { article, imageBytes: JPEG });
    const c = await submitJob(deps, { article: { ...article, body: "Other text entirely." }, imageBytes: PNG });
    expect(new Set([a.job.id, b.job.id, c.job.id]).size).toBe(3);
  });

  it("the same Idempotency-Key with a DIFFERENT payload is a conflict", async () => {
    const { deps } = setup();
    await submitJob(deps, { article, imageBytes: PNG, idempotencyKey: "order-42" });
    await expect(submitJob(deps, { article, imageBytes: JPEG, idempotencyKey: "order-42" })).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    const same = await submitJob(deps, { article, imageBytes: PNG, idempotencyKey: "order-42" });
    expect(same.replayed).toBe(true);
  });

  it("rejects an invalid key BEFORE writing anything (no stray file, no job)", async () => {
    const { deps, jobs } = setup();
    await expect(submitJob(deps, { article, imageBytes: PNG, idempotencyKey: "bad key!" })).rejects.toBeInstanceOf(
      InvalidIdempotencyKeyError,
    );
    expect(await storedFiles(deps.images)).toHaveLength(0);
    expect(jobs.rows.size).toBe(0);
  });

  it("rejects text that is valid as submitted but exceeds the limits AFTER normalisation (NFKC expansion) as a client error, not a database failure", async () => {
    const { deps, jobs } = setup();
    // 40 characters pass the 100-character input limit but normalise to 120, which the database CHECK would refuse.
    const err = await submitJob(deps, { article: { ...article, category: "ﬃ".repeat(40) }, imageBytes: PNG }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ZodError);
    expect(JSON.stringify((err as ZodError).issues)).toContain("category");
    expect(jobs.rows.size).toBe(0);
    expect(await storedFiles(deps.images)).toHaveLength(0); // rejected before the image was written
  });

  it("rejects an unsupported image BEFORE creating a job", async () => {
    const { deps, jobs } = setup();
    await expect(submitJob(deps, { article, imageBytes: GIF })).rejects.toMatchObject({ code: "unsupported_type" });
    await expect(submitJob(deps, { article, imageBytes: Buffer.alloc(0) })).rejects.toBeInstanceOf(ImageStorageError);
    expect(jobs.rows.size).toBe(0);
  });
});

describe("the insert-succeeded / enqueue-failed window", () => {
  it("answers QueueUnavailableError, keeps the job `queued` and unpublished, and reports its id", async () => {
    const { deps, jobs, state } = setup();
    state.up = false;
    const err = await submitJob(deps, { article, imageBytes: PNG }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QueueUnavailableError);
    const row = [...jobs.rows.values()][0]!;
    expect((err as QueueUnavailableError).jobId).toBe(row.id);
    expect(row).toMatchObject({ status: "queued", enqueuedAt: null });
  });

  it("a retry with the same payload publishes the existing job once Redis is back (no duplicate job)", async () => {
    const { deps, jobs, state } = setup();
    state.up = false;
    await submitJob(deps, { article, imageBytes: PNG }).catch(() => undefined);
    state.up = true;
    const r = await submitJob(deps, { article, imageBytes: PNG });
    expect(r.replayed).toBe(true);
    expect(jobs.rows.size).toBe(1);
    expect(state.published).toEqual([r.job.id]);
    expect([...jobs.rows.values()][0]?.enqueuedAt).not.toBeNull();
  });

  it("if the client never retries, the RECONCILER publishes the stored job and the worker completes it", async () => {
    const { deps, jobs, queue, state } = setup();
    state.up = false;
    await submitJob(deps, { article, imageBytes: PNG }).catch(() => undefined);
    state.up = true;
    const row = [...jobs.rows.values()][0]!;
    row.updatedAt = new Date(Date.now() - 3_600_000); // it has been stale for an hour

    const s = await reconcileOnce({
      jobs,
      queue,
      queuedStaleMs: 1000,
      processingStaleMs: 5000,
      limit: 10,
      log: () => {},
    });
    expect(s.requeued).toBe(1);
    expect(state.published).toEqual([row.id]);

    // the delivery now reaches a worker
    const matches = new FakeStore();
    matches.addImage(row.imageId, `${row.imageId}.png`);
    matches.articles.set(row.articleId, {
      id: row.articleId,
      title: "River walk",
      body: "A walk by the river among the trees.",
      category: "nature",
      tags: ["river"],
    });
    const provider = createMockProvider({
      classify: () => ({ category: "nature", tags: ["river", "trees"], confidence: 0.9 }),
    });
    const out = await processJob(row.id, {
      jobs,
      matches,
      provider,
      loadImage: async () => ({ base64: "aGVsbG8=", mimeType: "image/png" as const }),
      guardConfig: resolveGuardConfig({ minSimilarity: 0.05, minMargin: 0 }),
      pricing: {},
      log: () => {},
    });
    expect(out.kind).toBe("completed");
    expect(jobs.rows.get(row.id)?.status).toBe("completed");
  });
});
