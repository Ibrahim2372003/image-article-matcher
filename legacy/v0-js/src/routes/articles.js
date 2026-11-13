import { Router } from "express";
import { ArticleCreateSchema, formatZodError } from "../schemas/domain.js";
import { submitArticle } from "../services/ingestService.js";
import { asyncHandler, parseId, badRequest, notFound } from "./util.js";

export function createArticlesRouter({ store }) {
  const router = Router();

  router.post(
    "/",
    asyncHandler(async (req, res) => {
      const parsed = ArticleCreateSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, formatZodError(parsed.error));
      const { article, created, enqueued } = await submitArticle(store, parsed.data);
      return res.status(enqueued ? 202 : 200).json({ ...article, created, enqueued });
    })
  );

  router.get("/", asyncHandler(async (_req, res) => res.json(await store.listArticles())));

  router.get(
    "/:id",
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (!id) return badRequest(res, "id must be a positive integer");
      const article = await store.getArticle(id);
      if (!article) return notFound(res, `No article with id ${id}.`);
      return res.json(article);
    })
  );

  return router;
}
