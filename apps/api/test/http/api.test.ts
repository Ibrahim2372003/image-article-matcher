import type { AddressInfo } from "node:net";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiErrorSchema, JobSubmissionResponseSchema, JobViewSchema } from "@iam/shared";
import { createApp, type AppDeps } from "../../src/app.js";
import { createJobQueue, type JobQueue, type QueueLike } from "../../src/jobs/queue.js";
import { ImageStore } from "../../src/storage/imageStore.js";
import { FakeJobStore } from "../jobs/fakeJobStore.js";
import { GIF, HTML, JPEG, PNG } from "../storage/fixtures.js";

const KEY = "test-api-key-0123456789";
let dir = "";
let server: ReturnType<ReturnType<typeof createApp>["listen"]> | undefined;
let base = "";
const ctx = {
  jobs: new FakeJobStore(),
  queueUp: true,
  dbUp: true,
  published: [] as string[],
  images: undefined as unknown as ImageStore,
};

async function start(over: Partial<AppDeps> = {}) {
  ctx.jobs = new FakeJobStore();
  ctx.queueUp = true;
  ctx.dbUp = true;
  ctx.published = [];
  ctx.images = new ImageStore(path.join(dir, "images"), 200_000);
  const queue: JobQueue = {
    ensureQueued: async (j) => {
      if (!ctx.queueUp) throw new Error("Connection is closed.");
      ctx.published.push(j.id);
      return "added";
    },
    ping: async () => ctx.queueUp,
    close: async () => {},
  };
  const app = createApp({
    jobs: ctx.jobs,
    queue,
    images: ctx.images,
    apiKey: KEY,
    maxUploadBytes: 20_000,
    maxAttempts: 3,
    rateLimit: { max: 1000, windowMs: 60_000 },
    checkDatabase: async () => ctx.dbUp,
    ...over,
  });
  server = app.listen(0);
  await new Promise((r) => server!.once("listening", r));
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "iam-api-"));
});
afterEach(async () => {
  await new Promise((r) => server?.close(r));
  server = undefined;
  await rm(dir, { recursive: true, force: true });
});

const form = (
  over: {
    title?: string;
    body?: string;
    category?: string;
    tags?: string;
    image?: Buffer | null;
    filename?: string;
    type?: string;
    extra?: Record<string, string | Blob>;
  } = {},
) => {
  const fd = new FormData();
  fd.set("title", over.title ?? "River walk");
  fd.set("body", over.body ?? "A walk by the river among the trees.");
  if (over.category !== undefined) fd.set("category", over.category);
  else fd.set("category", "nature");
  if (over.tags !== undefined) fd.set("tags", over.tags);
  if (over.image !== null)
    fd.set("image", new Blob([over.image ?? PNG], { type: over.type ?? "image/png" }), over.filename ?? "photo.png");
  for (const [k, v] of Object.entries(over.extra ?? {})) fd.set(k, v);
  return fd;
};
const post = (fd: BodyInit | null, headers: Record<string, string> = { "x-api-key": KEY }) =>
  fetch(`${base}/jobs`, { method: "POST", body: fd, headers });
const errorOf = async (res: Response) => ApiErrorSchema.parse(await res.json()).error;
const stray = async () => (await readdir(path.join(ctx.images.root, ".tmp")).catch(() => [])).length;

describe("authentication (fails closed)", () => {
  it.each([
    ["no key", {}],
    ["wrong key", { "x-api-key": "wrong-key-0123456789" }],
    ["empty key", { "x-api-key": "" }],
    ["key with different length", { "x-api-key": KEY + "x" }],
  ])("POST /jobs with %s -> 401 and nothing is stored", async (_n, headers) => {
    await start();
    const res = await post(form(), headers);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/ApiKey/);
    expect((await errorOf(res)).code).toBe("unauthorized");
    expect(ctx.jobs.rows.size).toBe(0);
    expect(await readdir(ctx.images.root).catch(() => [])).toEqual([]);
  });
  it("GET /jobs/:id also requires the key", async () => {
    await start();
    const res = await fetch(`${base}/jobs/3f2c8d1e-9b7a-4c55-8e0f-1a2b3c4d5e6f`);
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(KEY);
  });
  it("with NO key configured every protected route answers 503, never 'open'", async () => {
    await start({ apiKey: undefined });
    expect((await post(form(), {})).status).toBe(503);
    expect((await post(form(), { "x-api-key": "anything" })).status).toBe(503);
    const get = await fetch(`${base}/jobs/3f2c8d1e-9b7a-4c55-8e0f-1a2b3c4d5e6f`, {
      headers: { "x-api-key": "anything" },
    });
    expect(get.status).toBe(503);
    expect((await errorOf(get)).code).toBe("api_key_not_configured");
  });
  it("/health and /ready need no key", async () => {
    await start();
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/ready`)).status).toBe(200);
  });
});

describe("POST /jobs", () => {
  it("accepts a valid submission: 202, Location, and a response that satisfies the shared schema", async () => {
    await start();
    const res = await post(form({ tags: JSON.stringify(["river", "trees"]) }));
    expect(res.status).toBe(202);
    const body = JobSubmissionResponseSchema.parse(await res.json());
    expect(body.replayed).toBe(false);
    expect(body.job).toMatchObject({ kind: "submission", status: "queued", decision: null, attempts: 0 });
    expect(res.headers.get("location")).toBe(`/jobs/${body.job.id}`);
    expect(ctx.published).toEqual([body.job.id]);
    expect(await stray()).toBe(0);
  });

  it("an identical resubmission returns 200 with the SAME job and does not publish again", async () => {
    await start();
    const a = JobSubmissionResponseSchema.parse(await (await post(form())).json());
    const res = await post(form());
    expect(res.status).toBe(200);
    const b = JobSubmissionResponseSchema.parse(await res.json());
    expect(b).toMatchObject({ replayed: true });
    expect(b.job.id).toBe(a.job.id);
    expect(ctx.published).toHaveLength(1);
    expect(ctx.jobs.rows.size).toBe(1);
  });

  it("an Idempotency-Key reused with a different payload -> 409 with the existing job id", async () => {
    await start();
    const h = { "x-api-key": KEY, "idempotency-key": "order-42" };
    const first = JobSubmissionResponseSchema.parse(await (await post(form(), h)).json());
    const res = await post(form({ image: JPEG }), h);
    expect(res.status).toBe(409);
    const err = await errorOf(res);
    expect(err.code).toBe("idempotency_conflict");
    expect(err.details).toEqual({ existingJobId: first.job.id });
    expect((await post(form(), h)).status).toBe(200); // the original payload still replays
  });

  it("rejects a malformed Idempotency-Key with 400", async () => {
    await start();
    const res = await post(form(), { "x-api-key": KEY, "idempotency-key": "has spaces!" });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("invalid_idempotency_key");
    expect(ctx.jobs.rows.size).toBe(0);
  });

  describe("validation", () => {
    it("missing image -> 400 image_required", async () => {
      await start();
      const res = await post(form({ image: null }));
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe("image_required");
    });
    it("invalid text fields -> 400 with field paths, and submitted values are NEVER echoed", async () => {
      await start();
      const res = await post(form({ title: "SECRET-VALUE-123", body: "   " }));
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).not.toContain("SECRET-VALUE-123");
      const err = ApiErrorSchema.parse(JSON.parse(text)).error;
      expect(err.code).toBe("validation_error");
      expect(JSON.stringify(err.details)).toContain("body");
      expect(ctx.jobs.rows.size).toBe(0);
    });
    it.each([["not json"], ['{"a":1}'], ["[1,2]"], ['["' + "x".repeat(60) + '"]']])(
      "bad tags %j -> 400",
      async (tags) => {
        await start();
        expect((await post(form({ tags }))).status).toBe(400);
      },
    );
    it("a JSON body is not multipart -> 415", async () => {
      await start();
      const res = await post(JSON.stringify({ title: "x" }), { "x-api-key": KEY, "content-type": "application/json" });
      expect(res.status).toBe(415);
      expect((await errorOf(res)).code).toBe("unsupported_media_type");
    });
    it("a second file or an unexpected file field -> 400 invalid_multipart", async () => {
      await start();
      const res = await post(form({ extra: { other: new Blob([PNG]) } }));
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe("invalid_multipart");
      expect(ctx.jobs.rows.size).toBe(0);
    });
  });

  describe("image upload security", () => {
    it("an oversized image -> 413, nothing stored, no temp files", async () => {
      await start();
      const big = Buffer.concat([PNG, Buffer.alloc(30_000)]);
      const res = await post(form({ image: big }));
      expect(res.status).toBe(413);
      expect((await errorOf(res)).code).toBe("payload_too_large");
      expect(ctx.jobs.rows.size).toBe(0);
      expect(await readdir(ctx.images.root).catch(() => [])).toEqual([]);
    });
    it("an oversized text field -> 413", async () => {
      await start();
      const res = await post(form({ body: "x".repeat(300_000) }));
      expect(res.status).toBe(413);
    });
    it.each([
      ["a GIF claiming image/png", GIF, "image/png", "x.png"],
      ["HTML claiming image/jpeg", HTML, "image/jpeg", "x.jpg"],
      ["an empty file", Buffer.alloc(0), "image/png", "empty.png"],
    ])(
      "%s is rejected by its BYTES (client MIME and file name are not trusted) -> 415",
      async (_n, bytes, type, filename) => {
        await start();
        const res = await post(form({ image: bytes, type, filename }));
        expect(res.status).toBe(415);
        expect((await errorOf(res)).code).toBe("unsupported_image_type");
        expect(ctx.jobs.rows.size).toBe(0);
      },
    );
    it("a real PNG with a hostile file name and wrong MIME is accepted and stored under a hash name only", async () => {
      await start();
      const res = await post(form({ image: PNG, filename: "../../../etc/passwd", type: "text/html" }));
      expect(res.status).toBe(202);
      const files = (await readdir(ctx.images.root)).filter((n) => !n.startsWith("."));
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^[0-9a-f]{64}\.png$/);
      expect(await stray()).toBe(0);
    });
    it("repeated and concurrent uploads leave no temp files behind", async () => {
      await start();
      await Promise.all([
        post(form()),
        post(form()),
        post(form({ image: JPEG })),
        post(form({ image: GIF })),
        post(form({ image: PNG, body: "different text" })),
      ]);
      expect(await stray()).toBe(0);
    });
  });

  describe("rate limiting", () => {
    it("returns 429 with Retry-After once the window budget is spent; unauthenticated calls do not consume it", async () => {
      await start({ rateLimit: { max: 2, windowMs: 60_000 } });
      for (let i = 0; i < 5; i += 1) expect((await post(form(), {})).status).toBe(401); // no key: not counted
      expect((await post(form())).status).toBe(202);
      expect((await post(form())).status).toBe(200);
      const limited = await post(form());
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
      expect((await errorOf(limited)).code).toBe("rate_limited");
    });
  });

  it("a text field that is valid as sent but too long after normalisation is a 400 validation_error, not a 500", async () => {
    await start();
    const res = await post(form({ category: "ﬃ".repeat(40) }));
    expect(res.status).toBe(400);
    const err = await errorOf(res);
    expect(err.code).toBe("validation_error");
    expect(JSON.stringify(err.details)).toContain("category");
    expect(ctx.jobs.rows.size).toBe(0);
  });

  describe("the insert-succeeded / enqueue-failed window", () => {
    it("a queue that NEVER answers (Redis down, BullMQ waiting forever) still yields a prompt 503, and the job stays recoverable", async () => {
      const hung: QueueLike = {
        getJob: () => new Promise(() => {}),
        add: () => new Promise(() => {}),
        close: async () => {},
      };
      await start({ queue: createJobQueue({ queue: hung, ping: async () => false, timeoutMs: 80 }) });
      const started = Date.now();
      const res = await post(form());
      expect(res.status).toBe(503);
      expect(Date.now() - started).toBeLessThan(3000);
      const err = await errorOf(res);
      expect(err.code).toBe("queue_unavailable");
      const jobId = (err.details as { jobId: string }).jobId;
      expect(ctx.jobs.rows.get(jobId)).toMatchObject({ status: "queued", enqueuedAt: null }); // the reconciler / a retry will publish it
    });

    it("503 queue_unavailable with the job id and Retry-After; the job exists; retrying the same request succeeds without duplicating it", async () => {
      await start();
      ctx.queueUp = false;
      const res = await post(form());
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("5");
      const err = await errorOf(res);
      expect(err.code).toBe("queue_unavailable");
      const jobId = (err.details as { jobId: string }).jobId;
      expect(ctx.jobs.rows.get(jobId)).toMatchObject({ status: "queued", enqueuedAt: null });

      ctx.queueUp = true;
      const retry = await post(form());
      expect(retry.status).toBe(200);
      expect(JobSubmissionResponseSchema.parse(await retry.json())).toMatchObject({
        replayed: true,
        job: { id: jobId },
      });
      expect(ctx.jobs.rows.size).toBe(1);
      expect(ctx.published).toEqual([jobId]);
    });
  });
});

describe("GET /jobs/:id", () => {
  it("returns the job; a failed job has status failed, decision null and a stable error code", async () => {
    await start();
    const job = ctx.jobs.seed({ status: "processing", attempts: 1 });
    await ctx.jobs.failPermanently(job.id, 1, {
      code: "provider_invalid_embedding",
      retryable: false,
      message: "bad vector",
    });
    const res = await fetch(`${base}/jobs/${job.id}`, { headers: { "x-api-key": KEY } });
    expect(res.status).toBe(200);
    const { job: view } = (await res.json()) as { job: unknown };
    expect(JobViewSchema.parse(view)).toMatchObject({
      status: "failed",
      decision: null,
      reasons: [],
      error: { code: "provider_invalid_embedding" },
    });
  });
  it("400 for a non-UUID id and 404 for an unknown job; both use the error envelope", async () => {
    await start();
    const bad = await fetch(`${base}/jobs/not-a-uuid`, { headers: { "x-api-key": KEY } });
    expect(bad.status).toBe(400);
    expect((await errorOf(bad)).code).toBe("invalid_id");
    const missing = await fetch(`${base}/jobs/3f2c8d1e-9b7a-4c55-8e0f-1a2b3c4d5e6f`, { headers: { "x-api-key": KEY } });
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe("not_found");
  });
});

describe("readiness and error hygiene", () => {
  it("/ready reports each component and 503 when the database or the queue is down, with no connection details", async () => {
    await start();
    expect(await (await fetch(`${base}/ready`)).json()).toEqual({
      status: "ready",
      checks: { database: "ok", queue: "ok" },
    });
    ctx.queueUp = false;
    const q = await fetch(`${base}/ready`);
    expect(q.status).toBe(503);
    expect(await q.json()).toEqual({ status: "not_ready", checks: { database: "ok", queue: "down" } });
    ctx.queueUp = true;
    ctx.dbUp = false;
    const d = await fetch(`${base}/ready`);
    expect(d.status).toBe(503);
    expect(await d.json()).toEqual({ status: "not_ready", checks: { database: "down", queue: "ok" } });
  });

  it("an unexpected internal error is a generic 500 that leaks nothing (no message, no connection string)", async () => {
    await start();
    ctx.jobs.createSubmission = async () => {
      throw new Error("could not connect to postgres://app:SUPERSECRET@db:5432/x");
    };
    const res = await post(form());
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("SUPERSECRET");
    expect(text).not.toContain("postgres://");
    expect(ApiErrorSchema.parse(JSON.parse(text)).error).toMatchObject({
      code: "internal_error",
      message: "Internal server error",
    });
  });

  it("every error carries the request id, and a client-supplied one is echoed", async () => {
    await start();
    const res = await fetch(`${base}/jobs/x`, { headers: { "x-api-key": KEY, "x-request-id": "req-abc" } });
    expect(res.headers.get("x-request-id")).toBe("req-abc");
    expect((await errorOf(res)).requestId).toBe("req-abc");
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});
