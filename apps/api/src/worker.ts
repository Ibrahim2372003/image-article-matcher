import { createProvider, describeProvider } from "./ai/factory.js";
import { checkDatabase, closePool, getPool } from "./db/pool.js";
import { loadEnv } from "./env.js";
import { PgJobStore } from "./jobs/pgJobStore.js";
import { sanitizeMessage } from "./jobs/failure.js";
import { processJob } from "./jobs/processor.js";
import { createBullJobQueue } from "./jobs/queue.js";
import { reconcileOnce, startReconciler } from "./jobs/reconciler.js";
import { parsePricing } from "./jobs/usage.js";
import { createBullWorker } from "./jobs/worker.js";
import { jsonLogger as log } from "./log.js";
import { guardConfigFromEnv } from "./matching/guard.js";
import { PgMatchStore } from "./matching/pgStore.js";
import { createRedis, quit } from "./redis.js";
import { registerShutdown } from "./shutdown.js";
import { ImageStore } from "./storage/imageStore.js";
import { createLoadImage } from "./storage/loadImage.js";

/** Separate worker process: consumes the queue, runs the pipeline, and reconciles stale jobs. No HTTP server. */
const env = loadEnv();
const pool = getPool(env);
if (!(await checkDatabase(pool))) {
  log("error", "database is not reachable; refusing to start the worker");
  process.exit(1);
}

const provider = createProvider(env);
const jobs = new PgJobStore(pool);
const matches = new PgMatchStore(pool);
const pricing = parsePricing(env.AI_PRICING_JSON);
const guardConfig = guardConfigFromEnv(env);
const images = new ImageStore(env.IMAGE_STORAGE_DIR, env.MAX_UPLOAD_BYTES);

const workerConnection = createRedis(env.REDIS_URL, "worker", log);
// The reconciler's connection FAILS FAST (unlike the worker's): a pass during an outage must end quickly so that
// shutdown never waits on it.
const queueConnection = createRedis(env.REDIS_URL, "publisher", log);
const queue = createBullJobQueue({
  connection: queueConnection,
  name: env.QUEUE_NAME,
  timeoutMs: env.QUEUE_PUBLISH_TIMEOUT_MS,
  onError: (err) => log("error", "queue error", { message: sanitizeMessage(err.message) }),
});

const worker = createBullWorker({
  connection: workerConnection,
  name: env.QUEUE_NAME,
  concurrency: env.WORKER_CONCURRENCY,
  backoff: { baseMs: env.JOB_BACKOFF_BASE_MS, maxMs: env.JOB_BACKOFF_MAX_MS },
  log,
  handler: (jobId) =>
    processJob(jobId, { jobs, matches, provider, loadImage: createLoadImage(images), guardConfig, pricing, log }),
});

const reconciler = startReconciler({
  intervalMs: env.JOB_RECONCILE_INTERVAL_MS,
  onError: (err) => log("error", "reconciler run failed", { error: err instanceof Error ? err.name : typeof err }),
  run: async () => {
    const s = await reconcileOnce({
      jobs,
      queue,
      queuedStaleMs: env.JOB_STALE_QUEUED_MS,
      processingStaleMs: env.JOB_STALE_PROCESSING_MS,
      limit: 50,
      log,
    });
    if (s.requeued > 0 || s.errors > 0) log("info", "reconcile pass", { ...s });
  },
});

log("info", "worker started", {
  provider: describeProvider(provider),
  concurrency: env.WORKER_CONCURRENCY,
  queue: env.QUEUE_NAME,
});

// Order: stop the reconciler, let the worker finish ACTIVE jobs (graceful), then close queue, Redis and the pool.
// If SHUTDOWN_TIMEOUT_MS elapses first the process exits 1; an interrupted job stays `processing` and is recovered
// by BullMQ's stalled-job check or the reconciler, and its attempt counter prevents endless crash loops.
registerShutdown({
  timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  closers: [
    () => reconciler.stop(),
    () => worker.close(),
    () => queue.close(),
    () => quit(workerConnection),
    () => quit(queueConnection),
    closePool,
  ],
});
