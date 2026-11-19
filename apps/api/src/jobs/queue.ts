import { Queue, type ConnectionOptions, type JobsOptions } from "bullmq";
import type { Redis } from "ioredis";

export interface QueuedJob {
  id: string;
  maxAttempts: number;
}

/** Delivery infrastructure only. PostgreSQL decides what a job IS; the queue just gets it in front of a worker. */
export interface JobQueue {
  /**
   * Makes sure a LIVE queue entry exists for the job. Idempotent: a live entry (waiting, delayed, active) is left
   * alone; a finished leftover (BullMQ keeps completed/failed jobs and a duplicate id would otherwise be ignored)
   * is removed and re-added. Payload is the job id only: no article text, no image data, no secrets.
   */
  ensureQueued(job: QueuedJob): Promise<"alive" | "added">;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

/** The slice of BullMQ's Queue this adapter uses (structurally typed so unit tests can fake it without Redis). */
export interface QueueLike {
  on?(event: "error", listener: (err: Error) => void): unknown;
  add(name: string, data: { jobId: string }, opts: JobsOptions): Promise<unknown>;
  getJob(id: string): Promise<{ getState(): Promise<string>; remove(): Promise<unknown> } | undefined>;
  close(): Promise<void>;
}

export const JOB_NAME = "analyze";
const LIVE_STATES = new Set(["waiting", "delayed", "active", "prioritized", "waiting-children"]);

export function jobOptions(job: QueuedJob): JobsOptions {
  return {
    jobId: job.id, // a UUID: BullMQ rejects ':' in custom ids
    // The database attempt counter is authoritative; the extra slack keeps BullMQ from giving up before it does.
    attempts: job.maxAttempts + 1,
    backoff: { type: "custom" }, // computed by the worker's bounded strategy
    removeOnComplete: { age: 3_600, count: 1_000 },
    removeOnFail: { age: 86_400, count: 1_000 },
  };
}

export const DEFAULT_QUEUE_TIMEOUT_MS = 3_000;

/**
 * BullMQ waits indefinitely for a Redis connection (even with the offline queue disabled), so without a deadline an
 * outage would hang the caller forever instead of surfacing as "queue unavailable". A timed-out call may still
 * complete later; that is harmless because publishing is idempotent per job id and PostgreSQL decides job state.
 */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`queue operation timed out after ${ms} ms`)), ms);
  });
  work.catch(() => undefined); // a late failure of the abandoned call must not become an unhandled rejection
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

export function createJobQueue(deps: {
  queue: QueueLike;
  ping: () => Promise<boolean>;
  closeExtra?: () => Promise<void>;
  timeoutMs?: number;
}): JobQueue {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;
  return {
    ensureQueued(job) {
      return withDeadline(
        (async () => {
          const existing = await deps.queue.getJob(job.id);
          if (existing) {
            const state = await existing.getState();
            if (LIVE_STATES.has(state)) return "alive" as const;
            await existing.remove(); // completed / failed / unknown leftover
          }
          await deps.queue.add(JOB_NAME, { jobId: job.id }, jobOptions(job));
          return "added" as const;
        })(),
        timeoutMs,
      );
    },
    ping: deps.ping,
    async close() {
      await deps.queue.close();
      await deps.closeExtra?.();
    },
  };
}

/**
 * Production queue over BullMQ. For the API process pass a connection created with `enableOfflineQueue: false`
 * so that publishing fails fast when Redis is down instead of hanging the request.
 */
export function createBullJobQueue(opts: {
  connection: Redis;
  name: string;
  pingTimeoutMs?: number;
  timeoutMs?: number;
  onError?: (err: Error) => void;
}): JobQueue {
  const queue = new Queue(opts.name, { connection: opts.connection as unknown as ConnectionOptions });
  // BullMQ re-emits connection errors on the queue; without a listener they surface as raw, unsanitised output.
  queue.on("error", (err: Error) => opts.onError?.(err));
  const timeout = opts.pingTimeoutMs ?? 2_000;
  return createJobQueue({
    timeoutMs: opts.timeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS,
    queue: queue as unknown as QueueLike,
    ping: async () => {
      try {
        const reply = await Promise.race([
          opts.connection.ping(),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("ping timeout")), timeout).unref()),
        ]);
        return reply === "PONG";
      } catch {
        return false;
      }
    },
  });
}
