import { classifyError } from "./failure.js";
import type { Logger } from "./processor.js";
import type { JobQueue } from "./queue.js";
import type { JobStore } from "./types.js";

export interface ReconcileOptions {
  jobs: JobStore;
  queue: JobQueue;
  queuedStaleMs: number;
  processingStaleMs: number;
  limit: number;
  log: Logger;
}
export interface ReconcileSummary {
  /** true when the pass stopped early because the queue is unreachable (nothing was changed). */
  aborted: boolean;
  checked: number;
  requeued: number;
  alive: number;
  errors: number;
}

/**
 * Recovers the failure windows between PostgreSQL and Redis:
 *  - the row was inserted but publishing failed (API crashed, Redis down): `queued`, never published;
 *  - Redis lost the entry or BullMQ gave up on a stalled job: `queued`/`processing` with no live queue entry.
 * For every stale open job it asks the queue to guarantee a live entry. A live entry (e.g. a delayed retry or a long
 * running job) is left untouched, so a job that is genuinely in progress is never run twice by the reconciler.
 * Duplicate deliveries that still happen are harmless: `claim` refuses terminal jobs and attempt-fencing stops
 * stale writers.
 */
export async function reconcileOnce(o: ReconcileOptions): Promise<ReconcileSummary> {
  const s: ReconcileSummary = { aborted: false, checked: 0, requeued: 0, alive: 0, errors: 0 };
  // Do not spend one timeout per stale job while Redis is down: that would also stall a graceful shutdown.
  if (!(await o.queue.ping())) {
    s.aborted = true;
    o.log("warn", "queue unreachable; skipping reconcile pass");
    return s;
  }
  const candidates = await o.jobs.findReconcileCandidates({
    queuedStaleMs: o.queuedStaleMs,
    processingStaleMs: o.processingStaleMs,
    limit: o.limit,
  });
  for (const c of candidates) {
    s.checked += 1;
    try {
      const r = await o.queue.ensureQueued({ id: c.id, maxAttempts: c.maxAttempts });
      if (r === "added") {
        await o.jobs.recordRequeued(c.id, c.status);
        s.requeued += 1;
        o.log("warn", "re-queued a stale job", { jobId: c.id, status: c.status, attempts: c.attempts });
      } else {
        s.alive += 1;
      }
    } catch (err) {
      s.errors += 1;
      o.log("error", "reconcile failed for a job", { jobId: c.id, code: classifyError(err).code });
      if (!(await o.queue.ping())) {
        s.aborted = true; // the queue went away mid-pass: stop; the next pass retries
        break;
      }
    }
  }
  return s;
}

/** Runs `run` immediately and then every `intervalMs`, never overlapping; errors are reported, never thrown. */
export function startReconciler(o: {
  intervalMs: number;
  run: () => Promise<unknown>;
  onError: (err: unknown) => void;
}): { stop(): Promise<void> } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: Promise<void> | null = null;
  const tick = (): void => {
    current = (async () => {
      try {
        await o.run();
      } catch (err) {
        o.onError(err);
      }
    })().finally(() => {
      current = null;
      if (!stopped) timer = setTimeout(tick, o.intervalMs);
    });
  };
  timer = setTimeout(tick, 0);
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await current;
    },
  };
}
