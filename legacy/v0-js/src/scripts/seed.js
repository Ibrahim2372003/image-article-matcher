import { pathToFileURL } from "node:url";
import { getPool, closePool } from "../db/pool.js";
import { PostgresStore } from "../store/postgresStore.js";
import { buildProviderFromEnv } from "../ai/providerFactory.js";
import { loadGuardConfig } from "../config.js";
import { loadImage } from "../services/imageLoader.js";
import { createHandlers } from "../jobs/handlers.js";
import { drainJobs } from "../jobs/worker.js";
import { loadManifest, manifestClassifications, ingestArticles, ingestImages } from "../dataset/ingest.js";

/**
 * Loads the evaluation corpus (articles + images) into PostgreSQL and
 * queues the background jobs. Idempotent. Without --process the running
 * server's worker picks the jobs up; with --process this script drains
 * them itself (useful for a one-shot run with no server).
 */
async function main() {
  const args = process.argv.slice(2);
  const shouldProcess = args.includes("--process");
  const delayArg = args.find((a) => a.startsWith("--delay-ms="));
  const delayBetweenJobsMs = delayArg ? Number(delayArg.split("=")[1]) : 0;

  const manifest = loadManifest();
  const store = new PostgresStore(getPool());

  const articleIds = await ingestArticles(store, manifest);
  console.log(`Articles ingested: ${articleIds.size}`);

  let handlers = null;
  const options = { delayBetweenJobsMs };
  if (shouldProcess) {
    const mockClassifications = process.env.AI_PROVIDER === "mock" ? manifestClassifications(manifest) : {};
    const provider = buildProviderFromEnv(process.env, { mockClassifications });
    const imagesRoot = process.env.IMAGES_DIR ?? "./eval/dataset/images";
    handlers = createHandlers({ store, provider, loadImage: (p) => loadImage(p, { root: imagesRoot }), guardConfig: loadGuardConfig() });
    // Articles first so every image's matching sees a complete article set.
    const results = await drainJobs(store, handlers, options);
    console.log(`Processed ${results.length} article job(s).`);
  }

  const imageIds = await ingestImages(store, manifest);
  console.log(`Images ingested: ${imageIds.size}`);

  if (shouldProcess) {
    const results = await drainJobs(store, handlers, options);
    const failed = results.filter((r) => r.status === "failed").length;
    console.log(`Processed ${results.length} job step(s); ${failed} failed. Pending retries (if any) remain queued.`);
  } else {
    console.log("Jobs queued. Start the server (npm start) so its worker processes them.");
  }
  await closePool();
}

const isDirectlyExecuted = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectlyExecuted) {
  main().catch((err) => {
    console.error("Seed failed:", err.message);
    process.exit(1);
  });
}
