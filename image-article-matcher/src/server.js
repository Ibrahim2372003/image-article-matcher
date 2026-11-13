import express from "express";
import { pathToFileURL } from "node:url";
import { getPool, closePool } from "./db/pool.js";
import { PostgresStore } from "./store/postgresStore.js";
import { NotFoundError } from "./ai/errors.js";
import { buildProviderFromEnv } from "./ai/providerFactory.js";
import { loadGuardConfig, loadJobConfig } from "./config.js";
import { loadImage } from "./services/imageLoader.js";
import { createHandlers } from "./jobs/handlers.js";
import { startWorker } from "./jobs/worker.js";
import { loadManifest, manifestClassifications } from "./dataset/ingest.js";
import { createImagesRouter } from "./routes/images.js";
import { createArticlesRouter } from "./routes/articles.js";
import { createSuggestionsRouter } from "./routes/suggestions.js";
import { createModelCallsRouter } from "./routes/modelCalls.js";
import { createJobsRouter } from "./routes/jobs.js";

/**
 * `store` is injected: production passes a PostgresStore; tests pass a
 * MemoryStore (or a stub) so no database server is needed to exercise
 * every route.
 */
export function createApp({ store }) {
  const app = express();
  app.use(express.json({ limit: "100kb" }));

  // Body-parser failures (malformed JSON, oversized body) are raised
  // before any route runs; answer them as JSON like every other error.
  app.use((err, _req, res, next) => {
    if (err?.type === "entity.too.large") return res.status(413).json({ error: "payload_too_large", message: "Request body exceeds the 100kb limit." });
    if (err?.type === "entity.parse.failed" || err instanceof SyntaxError) return res.status(400).json({ error: "invalid_json", message: "Request body is not valid JSON." });
    return next(err);
  });

  // Liveness is always 200; `database` is a diagnostic, never a gate.
  app.get("/health", async (_req, res) => {
    let database = "unreachable";
    try {
      await store.ping();
      database = "connected";
    } catch {
      database = "unreachable";
    }
    return res.json({ status: "ok", database });
  });

  app.use("/images", createImagesRouter({ store }));
  app.use("/articles", createArticlesRouter({ store }));
  app.use("/suggestions", createSuggestionsRouter({ store }));
  app.use("/model-calls", createModelCallsRouter({ store }));
  app.use("/jobs", createJobsRouter({ store }));

  app.use((req, res) => res.status(404).json({ error: "not_found", message: `No route for ${req.method} ${req.path}.` }));

  app.use((err, _req, res, _next) => {
    if (err instanceof NotFoundError) return res.status(404).json({ error: "not_found", message: err.message });
    console.error("Unhandled error:", err);
    return res.status(500).json({ error: "internal_error", message: "Something went wrong." });
  });

  return app;
}

// Cross-platform "run directly, not imported" check: pathToFileURL
// handles Windows backslash paths, and the undefined guard avoids a
// TypeError when process.argv[1] is absent (e.g. `node -e`).
const isDirectlyExecuted = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectlyExecuted) {
  const store = new PostgresStore(getPool());
  const mockClassifications = process.env.AI_PROVIDER === "mock" ? manifestClassifications(loadManifest()) : {};
  const provider = buildProviderFromEnv(process.env, { mockClassifications });
  const imagesRoot = process.env.IMAGES_DIR ?? "./eval/dataset/images";
  const handlers = createHandlers({
    store,
    provider,
    loadImage: (storagePath) => loadImage(storagePath, { root: imagesRoot }),
    guardConfig: loadGuardConfig(),
  });
  const jobConfig = loadJobConfig();
  const stopWorker = startWorker(store, handlers, {
    pollIntervalMs: jobConfig.pollIntervalMs,
    batchSize: jobConfig.batchSize,
    maxAttempts: jobConfig.maxAttempts,
  });

  const port = process.env.PORT || 3000;
  const server = createApp({ store }).listen(port, () => {
    console.log(`image-article-matcher listening on :${port} (provider: ${provider.name})`);
  });

  const shutdown = async () => {
    stopWorker();
    server.close();
    await closePool();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
