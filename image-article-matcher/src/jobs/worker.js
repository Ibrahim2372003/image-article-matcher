import { JOB_DEFAULTS } from "../config.js";
import { PermanentError } from "../ai/errors.js";

/** Exponential backoff: base, 2x base, 4x base ... capped at maxMs. */
export function computeBackoffMs(attempt, { baseMs = JOB_DEFAULTS.backoffBaseMs, maxMs = JOB_DEFAULTS.backoffMaxMs } = {}) {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

/** A failure is permanent if retrying cannot help (error says so) or no attempts remain. */
export function isPermanentFailure(err, { isFinalAttempt }) {
  return err?.retryable === false || isFinalAttempt === true;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function defaultOnFailure({ id, type, attempts, error }) {
  console.error(`[JOB FAILURE ALERT] job #${id} (${type}) failed permanently after ${attempts} attempt(s): ${error}`);
}

/**
 * Process up to `batchSize` due jobs, one at a time (sequential on
 * purpose: free-tier model APIs are rate limited, and one-at-a-time
 * keeps cost and ordering predictable). Each job is CLAIMED atomically
 * by the store (status queued -> running, attempts + 1) before its
 * handler runs, so a job can never be picked up twice — not by an
 * overlapping tick, not by a second worker process.
 *
 * Failure handling: a retryable error with attempts left puts the job
 * back to "queued" with run_after pushed out by exponential backoff; a
 * non-retryable error or the final attempt marks it "failed" and fires
 * the failure alert exactly once.
 */
export async function runJobsOnce(
  store,
  handlers,
  {
    batchSize = JOB_DEFAULTS.batchSize,
    maxAttempts = JOB_DEFAULTS.maxAttempts,
    visibilityTimeoutMs = JOB_DEFAULTS.visibilityTimeoutMs,
    now = () => new Date(),
    backoff = computeBackoffMs,
    delayBetweenJobsMs = 0,
    onFailure = defaultOnFailure,
    onRetry = () => {},
  } = {}
) {
  const results = [];
  for (let i = 0; i < batchSize; i += 1) {
    const job = await store.claimNextJob({ now: now(), visibilityTimeoutMs });
    if (!job) break;

    // A job reclaimed after repeated crashes must not loop forever.
    if (job.attempts > maxAttempts) {
      const error = `exceeded ${maxAttempts} attempts (a worker likely crashed mid-run)`;
      await store.markJobFailed(job.id, error);
      onFailure({ id: job.id, type: job.type, attempts: job.attempts, error });
      results.push({ id: job.id, type: job.type, status: "failed", attempts: job.attempts, error });
      continue;
    }

    const ctx = { jobId: job.id, attempt: job.attempts, maxAttempts, isFinalAttempt: job.attempts >= maxAttempts };
    try {
      const handler = handlers[job.type];
      if (!handler) throw new PermanentError(`no handler registered for job type "${job.type}"`);
      await handler(job.payload, ctx);
      await store.markJobDone(job.id);
      results.push({ id: job.id, type: job.type, status: "done", attempts: job.attempts });
    } catch (err) {
      if (isPermanentFailure(err, ctx)) {
        await store.markJobFailed(job.id, err.message);
        onFailure({ id: job.id, type: job.type, attempts: job.attempts, error: err.message });
        results.push({ id: job.id, type: job.type, status: "failed", attempts: job.attempts, error: err.message });
      } else {
        const retryInMs = backoff(job.attempts);
        await store.markJobRetry(job.id, { error: err.message, runAfter: new Date(now().getTime() + retryInMs) });
        onRetry({ id: job.id, type: job.type, attempts: job.attempts, error: err.message, retryInMs });
        results.push({ id: job.id, type: job.type, status: "retrying", attempts: job.attempts, error: err.message, retryInMs });
      }
    }
    if (delayBetweenJobsMs > 0) await sleep(delayBetweenJobsMs);
  }
  return results;
}

/**
 * Run passes until one processes nothing (used by the offline
 * evaluation and `seed --process`). Retried jobs become eligible again
 * only once their run_after passes, so callers that want retries to
 * finish quickly pass `backoff: () => 0`.
 */
export async function drainJobs(store, handlers, options = {}, { maxPasses = 1000 } = {}) {
  const all = [];
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const results = await runJobsOnce(store, handlers, { batchSize: 25, ...options });
    if (results.length === 0) break;
    all.push(...results);
  }
  return all;
}

/**
 * The worker loop. A recursive setTimeout, NOT setInterval: setInterval
 * fires on a fixed clock whether or not the previous tick finished, so a
 * slow tick would overlap the next one. Here the next tick is only
 * scheduled after the current one fully resolves, so two ticks of one
 * worker can never be in flight together. (Across processes, the
 * store's atomic claim provides the same guarantee.) Returns stop().
 */
export function startWorker(store, handlers, { pollIntervalMs = JOB_DEFAULTS.pollIntervalMs, ...runOptions } = {}) {
  let stopped = false;
  let timer = null;

  async function tick() {
    if (stopped) return;
    try {
      await runJobsOnce(store, handlers, runOptions);
    } catch (err) {
      console.error("[worker] tick failed:", err.message);
    }
    if (!stopped) {
      timer = setTimeout(tick, pollIntervalMs);
      timer.unref?.();
    }
  }

  timer = setTimeout(tick, pollIntervalMs);
  timer.unref?.();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
