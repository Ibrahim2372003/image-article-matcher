import { Router } from "express";
import { z } from "zod";
import { formatZodError } from "../schemas/domain.js";
import { asyncHandler, parseId, badRequest, notFound } from "./util.js";

const ListQuery = z.object({
  status: z.enum(["queued", "running", "done", "failed"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export function createJobsRouter({ store }) {
  const router = Router();

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const parsed = ListQuery.safeParse(req.query);
      if (!parsed.success) return badRequest(res, formatZodError(parsed.error));
      return res.json(await store.listJobs(parsed.data));
    })
  );

  router.get(
    "/:id",
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (!id) return badRequest(res, "id must be a positive integer");
      const job = await store.getJob(id);
      if (!job) return notFound(res, `No job with id ${id}.`);
      return res.json(job);
    })
  );

  return router;
}
