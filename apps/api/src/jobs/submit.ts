import { ArticleInputSchema, type ArticleInput } from "@iam/shared";
import type { ImageStore } from "../storage/imageStore.js";
import { QueueUnavailableError } from "./errors.js";
import { canonicalizeArticle, clientKey, derivedKey, requestFingerprint } from "./hash.js";
import type { JobQueue } from "./queue.js";
import type { JobRow, JobStore } from "./types.js";

export interface SubmitDeps {
  jobs: JobStore;
  queue: JobQueue;
  images: ImageStore;
  maxAttempts: number;
}

/**
 * Accepts one (article, image) pair. Order matters:
 *  1. validate the idempotency key and the image BEFORE anything is persisted;
 *  2. write the job row (PostgreSQL is the source of truth);
 *  3. publish to the queue. If publishing fails the row stays `queued` with `enqueued_at` NULL, the caller gets
 *     QueueUnavailableError, and either a retry with the same key or the reconciler publishes it later.
 * Image files are content-addressed, so a stored file left behind by a later failure is harmless and is reused.
 */
export async function submitJob(
  deps: SubmitDeps,
  input: { article: ArticleInput; imageBytes: Buffer; idempotencyKey?: string | undefined },
): Promise<{ job: JobRow; replayed: boolean }> {
  const explicitKey = input.idempotencyKey === undefined ? undefined : clientKey(input.idempotencyKey);
  const article = canonicalizeArticle(input.article);
  // Normalisation (NFKC) can lengthen text, so re-validate the canonical form against the same limits the database
  // enforces. A violation is a client error (400), not an opaque database failure.
  ArticleInputSchema.parse({
    title: article.title,
    body: article.body,
    category: article.category ?? undefined,
    tags: article.tags,
  });
  const image = await deps.images.save(input.imageBytes);
  const fingerprint = requestFingerprint(article.contentHash, image.sha256);

  const { job, outcome } = await deps.jobs.createSubmission({
    article,
    image: { sha256: image.sha256, mimeType: image.mimeType, byteSize: image.byteSize, storagePath: image.storagePath },
    idempotencyKey: explicitKey ?? derivedKey(article.contentHash, image.sha256),
    fingerprint,
    maxAttempts: deps.maxAttempts,
  });

  const needsPublish = outcome === "created" || (job.status === "queued" && job.enqueuedAt === null);
  if (needsPublish) {
    try {
      await deps.queue.ensureQueued({ id: job.id, maxAttempts: job.maxAttempts });
      await deps.jobs.markEnqueued(job.id, "api");
    } catch {
      throw new QueueUnavailableError(job.id);
    }
  }
  return { job, replayed: outcome === "replayed" };
}
