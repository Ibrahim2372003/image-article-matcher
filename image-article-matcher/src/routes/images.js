import { Router } from "express";
import { ImageCreateSchema, formatZodError } from "../schemas/domain.js";
import { submitImage } from "../services/ingestService.js";
import { asyncHandler, parseId, badRequest, notFound } from "./util.js";

export function createImagesRouter({ store }) {
  const router = Router();

  // Accepts an image reference and returns immediately; classification,
  // embedding and matching happen in the background worker.
  router.post(
    "/",
    asyncHandler(async (req, res) => {
      const parsed = ImageCreateSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, formatZodError(parsed.error));
      const { image, created, enqueued } = await submitImage(store, parsed.data);
      return res.status(enqueued ? 202 : 200).json({ ...image, created, enqueued });
    })
  );

  router.get("/", asyncHandler(async (_req, res) => res.json(await store.listImages())));

  router.get(
    "/:id",
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (!id) return badRequest(res, "id must be a positive integer");
      const image = await store.getImage(id);
      if (!image) return notFound(res, `No image with id ${id}.`);
      return res.json({ ...image, classification: await store.getLatestClassification(id) });
    })
  );

  router.get(
    "/:id/matches",
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (!id) return badRequest(res, "id must be a positive integer");
      const image = await store.getImage(id);
      if (!image) return notFound(res, `No image with id ${id}.`);
      return res.json({ image, suggestions: await store.listSuggestionsForImage(id) });
    })
  );

  // Re-run matching (e.g. after new articles were added). Reviewed
  // suggestions are preserved; see matchingService.generateMatches.
  router.post(
    "/:id/matches/refresh",
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (!id) return badRequest(res, "id must be a positive integer");
      if (!(await store.getImage(id))) return notFound(res, `No image with id ${id}.`);
      const jobId = await store.enqueueJob("generate_matches", { imageId: id, force: true });
      return res.status(202).json({ queued: true, jobId });
    })
  );

  return router;
}
