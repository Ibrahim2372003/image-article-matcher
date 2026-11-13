import { GUARD_DEFAULTS } from "../config.js";

/**
 * The Mismatch Guard: a PURE, deterministic function. It receives plain
 * numbers and labels — never a model, never a network handle — so no
 * LLM output can reach the decision except as an input value it is
 * checked against thresholds. Same inputs, same verdict, always.
 *
 * Every failed rule contributes one reason with a machine-readable code,
 * a human-readable explanation, and the exact signal values evaluated.
 * All failing rules are reported (not just the first) so a rejection is
 * fully explained; `primaryReasonCode` is the first in priority order.
 */
export const REASON_CODES = Object.freeze({
  LOW_CLASSIFICATION_CONFIDENCE: "LOW_CLASSIFICATION_CONFIDENCE",
  BELOW_SIMILARITY_THRESHOLD: "BELOW_SIMILARITY_THRESHOLD",
  CATEGORY_MISMATCH: "CATEGORY_MISMATCH",
  AMBIGUOUS_MATCH: "AMBIGUOUS_MATCH",
});

const normalize = (value) => String(value ?? "").trim().toLowerCase();
const fmt = (n, digits = 2) => (Number.isFinite(n) ? n.toFixed(digits) : String(n));

/**
 * @param {object} input
 * @param {{category:string, tags:string[], confidence:number}} input.classification
 * @param {{category?:string|null, tags?:string[]}} input.article
 * @param {number} input.similarity   cosine similarity (1 = identical direction)
 * @param {number} input.rank         1 = best candidate for this image
 * @param {number|null} [input.nextSimilarity] similarity of the runner-up, if any
 */
export function evaluateMatch({ classification, article, similarity, rank, nextSimilarity = null }, config = GUARD_DEFAULTS) {
  const reasons = [];

  const confidence = classification.confidence;
  const imageCategory = normalize(classification.category);
  const articleCategory = normalize(article.category);
  const imageTags = new Set((classification.tags ?? []).map(normalize).filter(Boolean));
  const articleTags = new Set((article.tags ?? []).map(normalize).filter(Boolean));
  const sharedTagCount = [...imageTags].filter((tag) => articleTags.has(tag)).length;
  const margin = nextSimilarity === null || nextSimilarity === undefined ? null : similarity - nextSimilarity;

  // Rule 1: the classification itself must be trustworthy. `!(x >= min)`
  // (not `x < min`) so a NaN fails the check instead of slipping past it.
  if (!(confidence >= config.minConfidence)) {
    reasons.push({
      code: REASON_CODES.LOW_CLASSIFICATION_CONFIDENCE,
      explanation: `The vision model's confidence in its classification (${fmt(confidence)}) is below the required minimum of ${fmt(config.minConfidence)}, so the image's metadata is too uncertain to base a match on.`,
      signals: { confidence, minConfidence: config.minConfidence },
    });
  }

  // Rule 2: the embeddings must actually be close.
  if (!(similarity >= config.minSimilarity)) {
    reasons.push({
      code: REASON_CODES.BELOW_SIMILARITY_THRESHOLD,
      explanation: `The image and article are not semantically close enough: cosine similarity ${fmt(similarity)} is below the required minimum of ${fmt(config.minSimilarity)}.`,
      signals: { similarity, minSimilarity: config.minSimilarity },
    });
  }

  // Rule 3: category/tag compatibility. Judged only when the article
  // declares a category; differing categories are tolerated if enough
  // tags are shared to show real topical overlap.
  if (imageCategory && articleCategory && imageCategory !== articleCategory && sharedTagCount < config.minSharedTags) {
    reasons.push({
      code: REASON_CODES.CATEGORY_MISMATCH,
      explanation: `The image category "${imageCategory}" differs from the article category "${articleCategory}", and they share ${sharedTagCount} tag(s) — fewer than the ${config.minSharedTags} required to treat the topics as compatible.`,
      signals: { imageCategory, articleCategory, sharedTagCount, minSharedTags: config.minSharedTags },
    });
  }

  // Rule 4: a near-tie for the top slot is too close to call automatically.
  if (rank === 1 && margin !== null && margin < config.minMargin) {
    reasons.push({
      code: REASON_CODES.AMBIGUOUS_MATCH,
      explanation: `The best candidate (similarity ${fmt(similarity)}) beats the runner-up (${fmt(nextSimilarity)}) by only ${fmt(margin, 3)}, less than the required margin of ${fmt(config.minMargin, 3)}, so the match is too close to call automatically.`,
      signals: { similarity, nextSimilarity, margin, minMargin: config.minMargin },
    });
  }

  return {
    decision: reasons.length === 0 ? "match" : "reject",
    primaryReasonCode: reasons.length === 0 ? null : reasons[0].code,
    reasons,
    signals: { confidence, similarity, rank, margin, sharedTagCount },
  };
}
