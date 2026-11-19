import { Redis } from "ioredis";
import { sanitizeMessage } from "./jobs/failure.js";
import type { Logger } from "./jobs/processor.js";

/** `kind: "worker"` sets maxRetriesPerRequest=null (a BullMQ requirement). `kind: "publisher"` fails fast when Redis is down. */
export function createRedis(url: string, kind: "worker" | "publisher", log: Logger): Redis {
  const redis = new Redis(
    url,
    kind === "worker" ? { maxRetriesPerRequest: null } : { enableOfflineQueue: false, maxRetriesPerRequest: 1 },
  );
  // Without a handler an ioredis error event is only printed; ours logs a sanitized message (URLs masked).
  redis.on("error", (err: Error) => log("error", "redis error", { kind, message: sanitizeMessage(err.message) }));
  return redis;
}

export async function quit(redis: Redis): Promise<void> {
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
}
