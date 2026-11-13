import { PermanentError } from "../ai/errors.js";
import { evaluateMatch } from "./mismatchGuard.js";
import { GUARD_DEFAULTS, MATCH_TOP_K } from "../config.js";

/**
 * Rank articles for an image by vector similarity, run EVERY candidate
 * through the deterministic Mismatch Guard, and persist all of them —
 * accepted and rejected, with their reasons — as an audit trail.
 *
 * Matching is by embedding similarity (pgvector in production). Nothing
 * here looks at filenames or keywords, and no AI call happens at this
 * stage at all, so no model can influence a decision.
 *
 * Idempotent: an image that already has suggestions is left alone
 * unless `force` is set. A forced re-run replaces only suggestions that
 * have no review — a human's approval/rejection is never silently erased.
 */
export async function generateMatches({ store, imageId, guardConfig = GUARD_DEFAULTS, topK = MATCH_TOP_K, force = false }) {
  const image = await store.getImage(imageId);
  if (!image) throw new PermanentError(`image ${imageId} not found`);

  if (!force && (await store.hasSuggestions(imageId))) {
    return { skipped: true, suggestions: await store.listSuggestionsForImage(imageId) };
  }

  const classification = await store.getLatestClassification(imageId);
  if (!classification) throw new PermanentError(`image ${imageId} has no classification`);
  if (!(await store.hasEmbedding("image", imageId))) throw new PermanentError(`image ${imageId} has no embedding`);

  const candidates = await store.findNearestArticles(imageId, topK);
  const evaluated = candidates.map((candidate, index) => {
    const verdict = evaluateMatch(
      {
        classification,
        article: { category: candidate.category, tags: candidate.tags },
        similarity: candidate.similarity,
        rank: index + 1,
        nextSimilarity: candidates[index + 1]?.similarity ?? null,
      },
      guardConfig
    );
    return { articleId: candidate.articleId, similarity: candidate.similarity, rank: index + 1, decision: verdict.decision, reasons: verdict.reasons };
  });

  await store.replaceSuggestionsForImage(imageId, evaluated);
  await store.setImageStatus(imageId, "matched");
  return { skipped: false, suggestions: await store.listSuggestionsForImage(imageId) };
}
