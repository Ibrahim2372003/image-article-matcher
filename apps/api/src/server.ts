import { createApp } from "./app.js";
import { checkDatabase, closePool, getPool } from "./db/pool.js";
import { assertApiKeyConfigured, loadEnv } from "./env.js";
import { sanitizeMessage } from "./jobs/failure.js";
import { createBullJobQueue } from "./jobs/queue.js";
import { PgJobStore } from "./jobs/pgJobStore.js";
import { jsonLogger as log } from "./log.js";
import { createRedis, quit } from "./redis.js";
import { registerShutdown } from "./shutdown.js";
import { ImageStore } from "./storage/imageStore.js";

const env = loadEnv();
assertApiKeyConfigured(env);
if (!env.API_KEY) log("warn", "API_KEY is not set: /jobs endpoints will answer 503 until it is configured");

const pool = getPool(env);
const redis = createRedis(env.REDIS_URL, "publisher", log);
const queue = createBullJobQueue({
  connection: redis,
  name: env.QUEUE_NAME,
  timeoutMs: env.QUEUE_PUBLISH_TIMEOUT_MS,
  onError: (err) => log("error", "queue error", { message: sanitizeMessage(err.message) }),
});

const app = createApp({
  jobs: new PgJobStore(pool),
  queue,
  images: new ImageStore(env.IMAGE_STORAGE_DIR, env.MAX_UPLOAD_BYTES),
  apiKey: env.API_KEY,
  maxUploadBytes: env.MAX_UPLOAD_BYTES,
  maxAttempts: env.JOB_MAX_ATTEMPTS,
  rateLimit: { max: env.RATE_LIMIT_MAX, windowMs: env.RATE_LIMIT_WINDOW_MS },
  checkDatabase: () => checkDatabase(pool),
});

const server = app.listen(env.PORT, () => {
  log("info", "api listening", { port: env.PORT, provider: env.AI_PROVIDER });
});

// Stop accepting HTTP first, then release queue, Redis and the pool.
registerShutdown({
  server,
  timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  closers: [() => queue.close(), () => quit(redis), closePool],
});
