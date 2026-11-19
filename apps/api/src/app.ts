import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler, type Express } from "express";
import { ZodError } from "zod";
import type { ApiError, Health } from "@iam/shared";
import { HttpError } from "./http/errors.js";
import { IdempotencyConflictError, InvalidIdempotencyKeyError, QueueUnavailableError } from "./jobs/errors.js";
import type { JobQueue } from "./jobs/queue.js";
import { createJobsRouter, type JobsRouterDeps } from "./routes/jobs.js";
import { ImageStorageError } from "./storage/errors.js";

const VERSION = "0.1.0";

export interface AppDeps extends JobsRouterDeps {
  queue: JobQueue;
  checkDatabase: () => Promise<boolean>;
}

const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p.catch(() => fallback), new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms).unref())]);

/** `createApp()` with no deps serves only /health (used by existing tests); with deps it also serves /ready and /jobs. */
export function createApp(deps?: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use((req, res, next) => {
    const id = req.header("x-request-id") ?? randomUUID();
    res.locals.requestId = id;
    res.setHeader("x-request-id", id);
    next();
  });

  app.get("/health", (_req, res) => {
    const body: Health = { status: "ok", version: VERSION, uptimeSeconds: Math.round(process.uptime()) };
    res.json(body);
  });

  if (deps) {
    // Readiness: can this instance accept work? Reports component status only; never connection details.
    app.get("/ready", async (_req, res) => {
      const [database, queue] = await Promise.all([
        withTimeout(deps.checkDatabase(), 2_000, false),
        withTimeout(deps.queue.ping(), 2_500, false),
      ]);
      const ready = database && queue;
      res.status(ready ? 200 : 503).json({
        status: ready ? "ready" : "not_ready",
        checks: { database: database ? "ok" : "down", queue: queue ? "ok" : "down" },
      });
    });
    app.use("/jobs", createJobsRouter(deps));
  }

  app.use((_req, res) => {
    const body: ApiError = {
      error: { code: "not_found", message: "Route not found", requestId: res.locals.requestId },
    };
    res.status(404).json(body);
  });

  app.use(errorHandler);
  return app;
}

function describe(err: unknown): {
  status: number;
  code: string;
  message: string;
  details?: unknown;
  headers?: Record<string, string>;
} {
  if (err instanceof HttpError)
    return {
      status: err.status,
      code: err.code,
      message: err.message,
      details: err.details,
      ...(err.headers ? { headers: err.headers } : {}),
    };
  if (err instanceof ZodError) {
    // Paths and rule messages only: submitted values are never echoed.
    return {
      status: 400,
      code: "validation_error",
      message: "Invalid request",
      details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    };
  }
  if (err instanceof InvalidIdempotencyKeyError) return { status: 400, code: err.code, message: err.message };
  if (err instanceof IdempotencyConflictError)
    return { status: 409, code: err.code, message: err.message, details: { existingJobId: err.existingJobId } };
  if (err instanceof QueueUnavailableError)
    return {
      status: 503,
      code: err.code,
      message: err.message,
      details: { jobId: err.jobId },
      headers: { "Retry-After": "5" },
    };
  if (err instanceof ImageStorageError) {
    if (err.code === "too_large") return { status: 413, code: "payload_too_large", message: err.message };
    if (err.code === "unsupported_type") return { status: 415, code: "unsupported_image_type", message: err.message };
    return { status: 400, code: "invalid_image", message: err.message };
  }
  const status =
    typeof err === "object" && err !== null && "status" in err && typeof err.status === "number" ? err.status : 500;
  if (status === 413) return { status, code: "payload_too_large", message: "Request body too large" };
  if (status >= 400 && status < 500) return { status, code: "bad_request", message: "Invalid request" };
  return { status: 500, code: "internal_error", message: "Internal server error" };
}

const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
  const d = describe(err);
  if (d.status >= 500 && d.status !== 503) {
    // Name only: never the message or stack (they can contain connection strings or user content).
    console.error(
      JSON.stringify({
        level: "error",
        msg: "unhandled request error",
        requestId: res.locals.requestId,
        error: err instanceof Error ? err.name : typeof err,
      }),
    );
  }
  for (const [k, v] of Object.entries(d.headers ?? {})) res.setHeader(k, v);
  const body: ApiError = {
    error: {
      code: d.code,
      message: d.message,
      requestId: res.locals.requestId,
      ...(d.details !== undefined ? { details: d.details } : {}),
    },
  };
  res.status(d.status).json(body);
};
