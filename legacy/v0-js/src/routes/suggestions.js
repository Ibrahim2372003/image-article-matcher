import { Router } from "express";
import { z } from "zod";
import { ReviewCreateSchema, formatZodError } from "../schemas/domain.js";
import { asyncHandler, parseId, badRequest, notFound } from "./util.js";

const ListQuery = z.object({
  decision: z.enum(["match", "reject"]).optional(),
  reviewState: z.enum(["unreviewed", "approved", "rejected"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/**
 * Suggestions + the Review API. A human review is stored SEPARATELY from
 * the guard's own decision: approving a guard-rejected suggestion (an
 * override) or rejecting a guard-approved one never rewrites what the
 * guard decided or why — both facts stay on record. Every review
 * requires reasoning (notes).
 */
export function createSuggestionsRouter({ store }) {
  const router = Router();

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const parsed = ListQuery.safeParse(req.query);
      if (!parsed.success) return badRequest(res, formatZodError(parsed.error));
      return res.json(await store.listSuggestions(parsed.data));
    })
  );

  router.get(
    "/:id",
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (!id) return badRequest(res, "id must be a positive integer");
      const suggestion = await store.getSuggestion(id);
      if (!suggestion) return notFound(res, `No suggestion with id ${id}.`);
      return res.json(suggestion);
    })
  );

  router.post(
    "/:id/review",
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (!id) return badRequest(res, "id must be a positive integer");
      const parsed = ReviewCreateSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, formatZodError(parsed.error));
      const review = await store.createReview({ suggestionId: id, ...parsed.data });
      return res.status(201).json({ review, suggestion: await store.getSuggestion(id) });
    })
  );

  return router;
}
