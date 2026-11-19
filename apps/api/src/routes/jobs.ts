import { Router, type NextFunction, type Request, type Response } from "express";
import multer, { MulterError } from "multer";
import { z } from "zod";
import { ArticleInputSchema, type JobSubmissionResponse } from "@iam/shared";
import { asyncHandler } from "../http/asyncHandler.js";
import { requireApiKey } from "../http/auth.js";
import { HttpError } from "../http/errors.js";
import { rateLimit } from "../http/rateLimit.js";
import { submitJob, type SubmitDeps } from "../jobs/submit.js";
import type { JobStore } from "../jobs/types.js";

export interface JobsRouterDeps extends SubmitDeps {
  jobs: JobStore;
  apiKey: string | undefined;
  maxUploadBytes: number;
  rateLimit: { max: number; windowMs: number };
}

const TAGS_MAX_BYTES = 8 * 1024;
const IdSchema = z.string().uuid();

/** Parses the multipart text fields through the shared article schema. Values are never echoed back in errors. */
function parseArticleFields(body: Record<string, unknown>) {
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  let tags: unknown = [];
  const rawTags = str(body.tags);
  if (rawTags !== undefined && rawTags.trim() !== "") {
    if (rawTags.length > TAGS_MAX_BYTES) throw new HttpError(400, "validation_error", "tags is too long");
    try {
      tags = JSON.parse(rawTags);
    } catch {
      throw new HttpError(400, "validation_error", 'tags must be a JSON array of strings, e.g. ["a","b"]');
    }
  }
  const category = str(body.category)?.trim();
  return ArticleInputSchema.parse({
    title: str(body.title),
    body: str(body.body),
    category: category === "" ? undefined : category,
    tags,
  });
}

export function createJobsRouter(deps: JobsRouterDeps): Router {
  const router = Router();
  const auth = requireApiKey(deps.apiKey);
  const limiter = rateLimit(deps.rateLimit);
  const upload = multer({
    storage: multer.memoryStorage(), // bounded by fileSize below: no temp files are created by the parser
    limits: { fileSize: deps.maxUploadBytes, files: 1, fields: 6, parts: 8, fieldSize: 256 * 1024, fieldNameSize: 100 },
  });

  const parseMultipart = (req: Request, res: Response, next: NextFunction): void => {
    if (!req.is("multipart/form-data"))
      return next(new HttpError(415, "unsupported_media_type", "Send multipart/form-data with an `image` file"));
    upload.single("image")(req, res, (err: unknown) => {
      if (!err) return next();
      if (err instanceof MulterError) {
        if (err.code === "LIMIT_FILE_SIZE")
          return next(new HttpError(413, "payload_too_large", `Image exceeds the ${deps.maxUploadBytes}-byte limit`));
        if (err.code === "LIMIT_FIELD_VALUE")
          return next(new HttpError(413, "payload_too_large", "A text field is too large"));
        return next(
          new HttpError(
            400,
            "invalid_multipart",
            "Unexpected or excessive multipart fields (only one `image` file is allowed)",
          ),
        );
      }
      return next(new HttpError(400, "invalid_multipart", "Malformed multipart body"));
    });
  };

  router.post(
    "/",
    auth,
    limiter,
    parseMultipart,
    asyncHandler(async (req, res) => {
      if (!req.file) throw new HttpError(400, "image_required", "An `image` file field is required");
      const article = parseArticleFields(req.body as Record<string, unknown>);
      const { job, replayed } = await submitJob(deps, {
        article,
        imageBytes: req.file.buffer,
        idempotencyKey: req.header("idempotency-key"),
      });
      const view = await deps.jobs.getJobView(job.id);
      if (!view) throw new Error("job vanished after creation");
      const body: JobSubmissionResponse = { job: view, replayed };
      res
        .status(replayed ? 200 : 202)
        .setHeader("Location", `/jobs/${job.id}`)
        .json(body);
    }),
  );

  router.get(
    "/:id",
    auth,
    asyncHandler(async (req, res) => {
      const id = IdSchema.safeParse(req.params.id);
      if (!id.success) throw new HttpError(400, "invalid_id", "Job id must be a UUID");
      const view = await deps.jobs.getJobView(id.data);
      if (!view) throw new HttpError(404, "not_found", "Job not found");
      res.json({ job: view });
    }),
  );

  return router;
}
