import { UnrecoverableError } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { createJobQueue, jobOptions, JOB_NAME, type QueueLike } from "../../src/jobs/queue.js";
import { handleDelivery, toBullResult } from "../../src/jobs/worker.js";
import type { ProcessOutcome } from "../../src/jobs/processor.js";

const ID = "3f2c8d1e-9b7a-4c55-8e0f-1a2b3c4d5e6f";

function fakeQueue(existing?: { state: string; removeFails?: boolean }) {
  const add = vi.fn(async () => ({}));
  const remove = vi.fn(async () => {
    if (existing?.removeFails) throw new Error("locked");
  });
  const close = vi.fn(async () => {});
  const q: QueueLike = {
    add,
    close,
    getJob: async () => (existing ? { getState: async () => existing.state, remove } : undefined),
  };
  return { q, add, remove, close };
}

describe("createJobQueue.ensureQueued", () => {
  it("adds a job that has no queue entry, with the DB id as BullMQ jobId and an ids-only payload", async () => {
    const { q, add } = fakeQueue();
    const queue = createJobQueue({ queue: q, ping: async () => true });
    expect(await queue.ensureQueued({ id: ID, maxAttempts: 3 })).toBe("added");
    expect(add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = add.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(name).toBe(JOB_NAME);
    expect(data).toEqual({ jobId: ID }); // ONLY the id: no article text, image data, keys or paths
    expect(opts.jobId).toBe(ID);
  });

  it.each(["waiting", "delayed", "active", "prioritized", "waiting-children"])(
    "a LIVE entry (%s) is left alone: no duplicate, no removal",
    async (state) => {
      const { q, add, remove } = fakeQueue({ state });
      expect(await createJobQueue({ queue: q, ping: async () => true }).ensureQueued({ id: ID, maxAttempts: 3 })).toBe(
        "alive",
      );
      expect(add).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    },
  );

  it.each(["completed", "failed", "unknown"])(
    "a finished leftover (%s) is removed and re-added (a same-id add would otherwise be silently ignored)",
    async (state) => {
      const { q, add, remove } = fakeQueue({ state });
      expect(await createJobQueue({ queue: q, ping: async () => true }).ensureQueued({ id: ID, maxAttempts: 3 })).toBe(
        "added",
      );
      expect(remove).toHaveBeenCalledTimes(1);
      expect(add).toHaveBeenCalledTimes(1);
    },
  );

  it("if removing the leftover fails it does NOT add a duplicate", async () => {
    const { q, add } = fakeQueue({ state: "failed", removeFails: true });
    await expect(
      createJobQueue({ queue: q, ping: async () => true }).ensureQueued({ id: ID, maxAttempts: 3 }),
    ).rejects.toThrow("locked");
    expect(add).not.toHaveBeenCalled();
  });

  it("propagates a publish failure (Redis down) so the caller can answer 503 and the reconciler can retry", async () => {
    const { q, add } = fakeQueue();
    add.mockRejectedValueOnce(new Error("Connection is closed."));
    await expect(
      createJobQueue({ queue: q, ping: async () => true }).ensureQueued({ id: ID, maxAttempts: 3 }),
    ).rejects.toThrow("Connection is closed.");
  });

  it("NEVER hangs: a queue that never answers (Redis down) rejects at the deadline", async () => {
    const never = new Promise<never>(() => {});
    for (const q of [
      { getJob: () => never, add: async () => ({}), close: async () => {} },
      { getJob: async () => undefined, add: () => never, close: async () => {} },
      {
        getJob: async () => ({ getState: () => never, remove: async () => ({}) }),
        add: async () => ({}),
        close: async () => {},
      },
    ] as QueueLike[]) {
      const started = Date.now();
      await expect(
        createJobQueue({ queue: q, ping: async () => true, timeoutMs: 40 }).ensureQueued({ id: ID, maxAttempts: 3 }),
      ).rejects.toThrow(/timed out after 40 ms/);
      expect(Date.now() - started).toBeLessThan(1000);
    }
  });

  it("a call abandoned at the deadline that fails LATER does not cause an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const q: QueueLike = {
        getJob: () => new Promise((_, rej) => setTimeout(() => rej(new Error("late failure")), 120)),
        add: async () => ({}),
        close: async () => {},
      };
      await expect(
        createJobQueue({ queue: q, ping: async () => true, timeoutMs: 30 }).ensureQueued({ id: ID, maxAttempts: 3 }),
      ).rejects.toThrow(/timed out/);
      await new Promise((r) => setTimeout(r, 250));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a fast call is unaffected by the deadline", async () => {
    const { q } = fakeQueue();
    expect(
      await createJobQueue({ queue: q, ping: async () => true, timeoutMs: 40 }).ensureQueued({
        id: ID,
        maxAttempts: 3,
      }),
    ).toBe("added");
  });

  it("close() closes the queue and any extra resource; ping() is delegated", async () => {
    const { q, close } = fakeQueue();
    const extra = vi.fn(async () => {});
    const queue = createJobQueue({ queue: q, ping: async () => false, closeExtra: extra });
    expect(await queue.ping()).toBe(false);
    await queue.close();
    expect(close).toHaveBeenCalled();
    expect(extra).toHaveBeenCalled();
  });
});

describe("jobOptions (bounded retries and retention)", () => {
  it("uses a UUID job id without ':' (BullMQ reserves it), custom bounded backoff, and slack over the DB attempt limit", () => {
    const o = jobOptions({ id: ID, maxAttempts: 3 });
    expect(o.jobId).not.toContain(":");
    expect(o.attempts).toBe(4);
    expect(o.backoff).toEqual({ type: "custom" });
  });
  it("retains finished jobs only for a bounded time/count", () => {
    const o = jobOptions({ id: ID, maxAttempts: 3 });
    expect(o.removeOnComplete).toMatchObject({ age: expect.any(Number), count: expect.any(Number) });
    expect(o.removeOnFail).toMatchObject({ age: expect.any(Number), count: expect.any(Number) });
  });
});

describe("worker delivery handling", () => {
  const outcome = (o: ProcessOutcome) => o;
  it.each([
    [outcome({ kind: "completed", status: "completed", decision: "accept", aiCalls: 3 })],
    [outcome({ kind: "skipped", reason: "terminal" })],
    [outcome({ kind: "skipped", reason: "missing" })],
    [outcome({ kind: "superseded" })],
  ])("success-like outcome %#: the delivery completes", (o) => {
    expect(() => toBullResult(o)).not.toThrow();
  });
  it("retry -> an ordinary error (BullMQ applies the bounded backoff and retries)", () => {
    const o = outcome({
      kind: "retry",
      attempt: 1,
      failure: { code: "provider_timeout", retryable: true, message: "x" },
    });
    expect(() => toBullResult(o)).toThrow("provider_timeout");
    expect(() => toBullResult(o)).not.toThrow(UnrecoverableError);
  });
  it("failed -> UnrecoverableError (BullMQ must NOT retry; the DB row already says failed)", () => {
    const o = outcome({
      kind: "failed",
      attempt: 1,
      failure: { code: "provider_invalid_embedding", retryable: false, message: "x" },
    });
    expect(() => toBullResult(o)).toThrow(UnrecoverableError);
  });
  it("handleDelivery passes only a validated job id to the handler", async () => {
    const handler = vi.fn(async (): Promise<ProcessOutcome> => ({ kind: "skipped", reason: "terminal" }));
    await handleDelivery({ jobId: ID }, handler);
    expect(handler).toHaveBeenCalledWith(ID);
  });
  it.each([
    undefined,
    null,
    {},
    { jobId: "not-a-uuid" },
    { jobId: ID, body: "article text must never travel through Redis" },
    "string",
    42,
  ])("a malformed payload %j is unrecoverable and never reaches the handler", async (payload) => {
    const handler = vi.fn();
    await expect(handleDelivery(payload, handler)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(handler).not.toHaveBeenCalled();
  });
});
