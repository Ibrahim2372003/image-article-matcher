import { UnrecoverableError, Worker, type ConnectionOptions } from "bullmq";
import type { Redis } from "ioredis";
import { z } from "zod";
import { computeBackoffMs, type BackoffConfig } from "./lifecycle.js";
import { sanitizeMessage } from "./failure.js";
import type { Logger, ProcessOutcome } from "./processor.js";

const PayloadSchema = z.object({ jobId: z.string().uuid() }).strict();

/**
 * Translates a processor outcome for BullMQ: success-like outcomes return (job done); `retry` throws an ordinary
 * error so BullMQ applies the bounded backoff; `failed` throws UnrecoverableError so BullMQ never retries it.
 * The database row already holds the authoritative state by the time this runs.
 */
export function toBullResult(outcome: ProcessOutcome): void {
  if (outcome.kind === "retry") throw new Error(`retry scheduled: ${outcome.failure.code}`);
  if (outcome.kind === "failed") throw new UnrecoverableError(`${outcome.failure.code}`);
}

/** Validates the payload (ids only) and runs the handler. A malformed payload can never succeed, so it is unrecoverable. */
export async function handleDelivery(
  data: unknown,
  handler: (jobId: string) => Promise<ProcessOutcome>,
): Promise<void> {
  const parsed = PayloadSchema.safeParse(data);
  if (!parsed.success) throw new UnrecoverableError("invalid_job_payload");
  toBullResult(await handler(parsed.data.jobId));
}

export interface BullWorker {
  /** Graceful: waits for active jobs. force=true abandons them (they are recovered via the stalled check / reconciler). */
  close(force?: boolean): Promise<void>;
}

export function createBullWorker(opts: {
  connection: Redis; // must be created with maxRetriesPerRequest: null (BullMQ requirement for workers)
  name: string;
  concurrency: number;
  backoff: BackoffConfig;
  handler: (jobId: string) => Promise<ProcessOutcome>;
  log: Logger;
}): BullWorker {
  const worker = new Worker(opts.name, (job) => handleDelivery(job.data, opts.handler), {
    connection: opts.connection as unknown as ConnectionOptions,
    concurrency: opts.concurrency,
    settings: { backoffStrategy: (attemptsMade: number) => computeBackoffMs(attemptsMade, opts.backoff) },
  });
  worker.on("error", (err) => opts.log("error", "worker error", { message: sanitizeMessage(err.message) }));
  worker.on("failed", (job, err) =>
    opts.log("info", "delivery failed", { jobId: job?.id, message: sanitizeMessage(err.message) }),
  );
  return { close: (force = false) => worker.close(force) };
}
