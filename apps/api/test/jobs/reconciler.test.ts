import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobQueue } from "../../src/jobs/queue.js";
import { reconcileOnce, startReconciler } from "../../src/jobs/reconciler.js";
import { FakeJobStore } from "./fakeJobStore.js";

const OLD = new Date(Date.now() - 3_600_000);
const silent = () => {};
const opts = { queuedStaleMs: 1000, processingStaleMs: 5000, limit: 50, log: silent };
const queueOf = (impl: JobQueue["ensureQueued"]): JobQueue & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    ensureQueued: async (j) => {
      calls.push(j.id);
      return impl(j);
    },
    ping: async () => true,
    close: async () => {},
  };
};

describe("reconcileOnce", () => {
  it("re-publishes a job that was stored but never published (insert succeeded, enqueue failed)", async () => {
    const jobs = new FakeJobStore();
    const j = jobs.seed({ updatedAt: OLD, enqueuedAt: null });
    const queue = queueOf(async () => "added");
    const s = await reconcileOnce({ ...opts, jobs, queue });
    expect(s).toEqual({ aborted: false, checked: 1, requeued: 1, alive: 0, errors: 0 });
    expect(queue.calls).toEqual([j.id]);
    expect(jobs.requeued).toEqual([j.id]); // audited and marked as published
  });

  it("leaves a job alone when the queue still holds a live entry (delayed retry / long-running job)", async () => {
    const jobs = new FakeJobStore();
    jobs.seed({ status: "processing", attempts: 1, updatedAt: OLD });
    const s = await reconcileOnce({ ...opts, jobs, queue: queueOf(async () => "alive") });
    expect(s).toMatchObject({ checked: 1, requeued: 0, alive: 1 });
    expect(jobs.requeued).toEqual([]);
  });

  it("recovers a `processing` job whose queue entry is gone", async () => {
    const jobs = new FakeJobStore();
    const j = jobs.seed({ status: "processing", attempts: 1, updatedAt: OLD });
    const s = await reconcileOnce({ ...opts, jobs, queue: queueOf(async () => "added") });
    expect(s.requeued).toBe(1);
    expect(jobs.requeued).toEqual([j.id]);
  });

  it("ignores fresh jobs and terminal jobs", async () => {
    const jobs = new FakeJobStore();
    jobs.seed({ updatedAt: new Date() }); // fresh
    jobs.seed({ status: "completed", updatedAt: OLD });
    jobs.seed({ status: "failed", updatedAt: OLD });
    jobs.seed({ status: "needs_review", updatedAt: OLD });
    const queue = queueOf(async () => "added");
    expect((await reconcileOnce({ ...opts, jobs, queue })).checked).toBe(0);
    expect(queue.calls).toEqual([]);
  });

  it("one failing job does not stop the pass; errors are counted and logged without secrets", async () => {
    const jobs = new FakeJobStore();
    const a = jobs.seed({ updatedAt: OLD });
    const b = jobs.seed({ updatedAt: OLD });
    const logs: Array<[string, Record<string, unknown>?]> = [];
    const queue = queueOf(async (j) => {
      if (j.id === a.id) throw new Error("Connection is closed. redis://:hunter2@host:6379");
      return "added";
    });
    const s = await reconcileOnce({ ...opts, jobs, queue, log: (_l, m, f) => logs.push([m, f]) });
    expect(s).toMatchObject({ checked: 2, requeued: 1, errors: 1 });
    expect(jobs.requeued).toEqual([b.id]);
    expect(JSON.stringify(logs)).not.toContain("hunter2");
  });

  it("is idempotent: once re-published the job is no longer stale, so a second pass does nothing", async () => {
    const jobs = new FakeJobStore();
    jobs.seed({ updatedAt: OLD });
    const queue = queueOf(async () => "added");
    expect((await reconcileOnce({ ...opts, jobs, queue })).requeued).toBe(1);
    expect((await reconcileOnce({ ...opts, jobs, queue })).checked).toBe(0);
  });

  it("skips the whole pass (touching nothing) when the queue is unreachable, instead of waiting out a timeout per job", async () => {
    const jobs = new FakeJobStore();
    for (let i = 0; i < 5; i += 1) jobs.seed({ updatedAt: OLD });
    const queue = { ...queueOf(async () => "added"), ping: async () => false };
    const s = await reconcileOnce({ ...opts, jobs, queue });
    expect(s).toEqual({ aborted: true, checked: 0, requeued: 0, alive: 0, errors: 0 });
    expect(queue.calls).toEqual([]);
    expect(jobs.requeued).toEqual([]);
  });

  it("stops the pass early when the queue goes away mid-pass; already re-published jobs stay recorded", async () => {
    const jobs = new FakeJobStore();
    const ids = [0, 1, 2, 3].map(() => jobs.seed({ updatedAt: OLD }).id);
    let up = true;
    const queue: JobQueue & { calls: string[] } = {
      calls: [],
      ensureQueued: async (j) => {
        queue.calls.push(j.id);
        if (queue.calls.length === 2) {
          up = false;
          throw new Error("queue operation timed out");
        }
        return "added";
      },
      ping: async () => up,
      close: async () => {},
    };
    const s = await reconcileOnce({ ...opts, jobs, queue });
    expect(s).toMatchObject({ aborted: true, requeued: 1, errors: 1 });
    expect(queue.calls).toHaveLength(2); // jobs 3 and 4 were not even attempted
    expect(jobs.requeued).toEqual([queue.calls[0]]);
    expect(ids).toEqual(expect.arrayContaining(queue.calls));
  });

  it("respects the batch limit", async () => {
    const jobs = new FakeJobStore();
    for (let i = 0; i < 5; i += 1) jobs.seed({ updatedAt: OLD });
    expect((await reconcileOnce({ ...opts, limit: 2, jobs, queue: queueOf(async () => "added") })).checked).toBe(2);
  });
});

describe("startReconciler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs immediately and then on the interval", async () => {
    const run = vi.fn(async () => {});
    const r = startReconciler({ intervalMs: 1000, run, onError: silent });
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2500);
    expect(run).toHaveBeenCalledTimes(3);
    await r.stop();
  });

  it("never overlaps runs, even when a run takes longer than the interval", async () => {
    let active = 0;
    let maxActive = 0;
    const run = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5000));
      active -= 1;
    };
    const r = startReconciler({ intervalMs: 100, run, onError: silent });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(maxActive).toBe(1);
    const stopping = r.stop(); // waits for the in-flight run, which needs (fake) time to finish
    await vi.advanceTimersByTimeAsync(6000);
    await stopping;
  });

  it("reports errors via onError and keeps running", async () => {
    const onError = vi.fn();
    const run = vi.fn(async () => Promise.reject(new Error("db down")));
    const r = startReconciler({ intervalMs: 1000, run, onError });
    await vi.advanceTimersByTimeAsync(2500);
    expect(onError).toHaveBeenCalledTimes(3);
    await r.stop();
  });

  it("stop() waits for the in-flight run and schedules nothing afterwards", async () => {
    let finished = false;
    const run = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 3000));
      finished = true;
    });
    const r = startReconciler({ intervalMs: 1000, run, onError: silent });
    await vi.advanceTimersByTimeAsync(10); // run started
    const stopping = r.stop();
    await vi.advanceTimersByTimeAsync(3000);
    await stopping;
    expect(finished).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
