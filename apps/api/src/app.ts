import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler, type Express } from "express";
import type { ApiError, Health } from "@iam/shared";

const VERSION = "0.1.0";

export function createApp(): Express {
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

  app.use((_req, res) => {
    const body: ApiError = {
      error: { code: "not_found", message: "Route not found", requestId: res.locals.requestId },
    };
    res.status(404).json(body);
  });

  const onError: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
    const status =
      typeof err === "object" && err !== null && "status" in err && typeof err.status === "number" ? err.status : 500;
    const body: ApiError = {
      error: {
        code: status === 400 ? "bad_request" : "internal_error",
        message: status === 500 ? "Internal server error" : "Invalid request",
        requestId: res.locals.requestId,
      },
    };
    res.status(status).json(body);
  };
  app.use(onError);
  return app;
}
