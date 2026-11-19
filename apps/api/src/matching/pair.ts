import {
  ArticleNotFoundError,
  ImageNotFoundError,
  IncompatibleEmbeddingModelError,
  MissingPrerequisiteError,
} from "./errors.js";
import { evaluateMatch, resolveGuardConfig, type GuardConfig, type GuardResult } from "./guard.js";
import { describeSpace, sameSpace, type EmbeddingSpace, type MatchStore, type StoredClassification } from "./types.js";

export interface PairEvaluation {
  result: GuardResult;
  similarity: number;
  rank: number;
  nextSimilarity: number | null;
  classification: StoredClassification;
  space: EmbeddingSpace;
  guardConfig: GuardConfig;
}

/**
 * Evaluates ONE image against ONE specific target article with the unchanged Mismatch Guard. Unlike the top-K
 * ranking, the target need not be among the best candidates: its exact similarity and rank come straight from the
 * store. The runner-up is only supplied when the target ranks first (the only case where the ambiguity rule
 * applies). Like all matching code it makes no AI call, so no model can influence the decision.
 */
export async function evaluatePair(args: {
  store: MatchStore;
  imageId: string;
  articleId: string;
  space: EmbeddingSpace;
  guardConfig?: GuardConfig;
}): Promise<PairEvaluation> {
  const { store, imageId, articleId, space } = args;
  const guardConfig = args.guardConfig ?? resolveGuardConfig();

  if (!(await store.getImage(imageId))) throw new ImageNotFoundError(imageId);
  const article = await store.getArticle(articleId);
  if (!article) throw new ArticleNotFoundError(articleId);

  const classification = await store.getLatestClassification(imageId);
  if (!classification) throw new MissingPrerequisiteError("classification", `image ${imageId} has not been classified`);

  const imageSpaces = await store.listImageEmbeddingSpaces(imageId);
  if (imageSpaces.length === 0)
    throw new MissingPrerequisiteError("image embedding", `image ${imageId} has no embedding`);
  if (!imageSpaces.some((s) => sameSpace(s, space))) {
    throw new IncompatibleEmbeddingModelError(describeSpace(space), imageSpaces.map(describeSpace), `image ${imageId}`);
  }
  const articleSpaces = await store.listEmbeddingSpacesForArticle(articleId);
  if (articleSpaces.length === 0)
    throw new MissingPrerequisiteError("article embeddings", `article ${articleId} has no embedding`);
  if (!articleSpaces.some((s) => sameSpace(s, space))) {
    throw new IncompatibleEmbeddingModelError(
      describeSpace(space),
      articleSpaces.map(describeSpace),
      `article ${articleId}`,
    );
  }

  const ctx = await store.getPairContext(imageId, articleId, space);
  if (!ctx)
    throw new MissingPrerequisiteError(
      "article embeddings",
      `article ${articleId} has no embedding in ${describeSpace(space)}`,
    );

  const nextSimilarity = ctx.rank === 1 ? ctx.bestOtherSimilarity : null;
  const result = evaluateMatch(
    {
      classification: {
        category: classification.category,
        tags: classification.tags,
        confidence: classification.confidence,
      },
      article: { category: article.category, tags: article.tags },
      similarity: ctx.similarity,
      rank: ctx.rank,
      nextSimilarity,
    },
    guardConfig,
  );
  return { result, similarity: ctx.similarity, rank: ctx.rank, nextSimilarity, classification, space, guardConfig };
}
