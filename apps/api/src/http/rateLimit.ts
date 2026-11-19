import type { RequestHandler } from "express";
import { HttpError } from "./errors.js";

/**
 * Fixed-window limiter per client address, held IN MEMORY: it is per API process (not shared across replicas) and
 * resets on restart. It bounds upload abuse from a single client, not a distributed attack. When running behind a
 * proxy, configure Express `trust proxy` so `req.ip` is the real client.
 */
export function rateLimit(opts: { max: number; windowMs: number; now?: () => number }): RequestHandler {
  const now = opts.now ?? Date.now;
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req, _res, next) => {
    const t = now();
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k); // bound memory
    const key = req.ip ?? "unknown";
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + opts.windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > opts.max) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - t) / 1000));
      return next(
        new HttpError(429, "rate_limited", "Too many requests", undefined, { "Retry-After": String(retryAfter) }),
      );
    }
    next();
  };
}
