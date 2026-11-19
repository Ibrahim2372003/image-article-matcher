import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { HttpError } from "./errors.js";

const digest = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

/**
 * `X-API-Key` authentication. FAILS CLOSED: when no key is configured every protected route answers 503, never
 * "open". Keys are compared as fixed-length SHA-256 digests with timingSafeEqual, so neither the key's length nor
 * a matching prefix is observable through timing. The key is never logged or echoed.
 */
export function requireApiKey(configuredKey: string | undefined): RequestHandler {
  const expected = configuredKey ? digest(configuredKey) : null;
  return (req, _res, next) => {
    if (!expected) return next(new HttpError(503, "api_key_not_configured", "The server has no API key configured"));
    const given = req.header("x-api-key");
    if (!given || !timingSafeEqual(digest(given), expected)) {
      return next(
        new HttpError(401, "unauthorized", "A valid X-API-Key header is required", undefined, {
          "WWW-Authenticate": 'ApiKey realm="image-article-matcher"',
        }),
      );
    }
    next();
  };
}
