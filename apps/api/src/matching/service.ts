import { EMBEDDING_TASK_TYPE, MATCH_TOP_K } from "@iam/shared";
import { IncompatibleEmbeddingModelError, ImageNotFoundError, MissingPrerequisiteError } from "./errors.js";
import { resolveGuardConfig, type GuardConfig } from "./guard.js";
import { evaluateCandidates } from "./ranking.js";
import {
  describeSpace,
  sameSpace,
  type EmbeddingSpace,
  type EvaluationRecord,
  type MatchStore,
  type SaveOutcome,
  type StoredEvaluation,
} from "./types.js";

export interface GenerateMatchesInput {
  store: MatchStore;
  imageId: string;
  /** The embedding model both vectors must come from (normally `provider.embeddingModel`). */
  embeddingModel: string;
  /** The embedding task type both vectors must use. Defaults to the project-wide task type. */
  taskType?: string;
  guardConfig?: GuardConfig;
  topK?: number;
  /** Re-evaluate even if this image already has results. Reviewed results are still never overwritten. */
  force?: boolean;
}

export interface GenerateMatchesResult {
  skipped: boolean;
  outcomes: Record<SaveOutcome, number>;
  evaluations: StoredEvaluation[];
}

/**
 * image -> pgvector nearest articles (same embedding space only) -> deterministic guard for EVERY candidate
 * -> persisted (accepted, rejected and needs-review alike) with scores and machine-readable reasons.
 *
 * No AI call happens here, so no model can influence a decision. Matching is by embedding similarity only;
 * filenames and keywords are never consulted. Idempotent and atomic: results are keyed per (image, article)
 * and written in ONE transaction, so a failed run persists nothing; a re-run updates unreviewed rows in place
 * and leaves human-reviewed rows untouched.
 */
export async function generateMatches(input: GenerateMatchesInput): Promise<GenerateMatchesResult> {
  const { store, imageId, force = false } = input;
  const space: EmbeddingSpace = { model: input.embeddingModel, taskType: input.taskType ?? EMBEDDING_TASK_TYPE };
  const topK = input.topK ?? MATCH_TOP_K;
  const guardConfig = input.guardConfig ?? resolveGuardConfig();
  if (!Number.isInteger(topK) || topK < 1 || topK > 50)
    throw new RangeError("topK must be an integer between 1 and 50");

  if (!(await store.getImage(imageId))) throw new ImageNotFoundError(imageId);
  const empty = { created: 0, updated: 0, preserved: 0 };
  if (!force && (await store.hasEvaluations(imageId))) {
    return { skipped: true, outcomes: empty, evaluations: await store.listEvaluationsForImage(imageId) };
  }

  const classification = await store.getLatestClassification(imageId);
  if (!classification) throw new MissingPrerequisiteError("classification", `image ${imageId} has not been classified`);

  const imageSpaces = await store.listImageEmbeddingSpaces(imageId);
  if (imageSpaces.length === 0)
    throw new MissingPrerequisiteError("image embedding", `image ${imageId} has no embedding`);
  if (!imageSpaces.some((s) => sameSpace(s, space))) {
    throw new IncompatibleEmbeddingModelError(describeSpace(space), imageSpaces.map(describeSpace), `image ${imageId}`);
  }

  const candidates = await store.findNearestArticles(imageId, space, topK);
  if (candidates.length === 0) {
    const articleSpaces = await store.listArticleEmbeddingSpaces();
    if (articleSpaces.length === 0)
      throw new MissingPrerequisiteError("article embeddings", "no articles have been embedded");
    if (!articleSpaces.some((s) => sameSpace(s, space))) {
      throw new IncompatibleEmbeddingModelError(
        describeSpace(space),
        articleSpaces.map(describeSpace),
        "the article corpus",
      );
    }
    return { skipped: false, outcomes: empty, evaluations: [] };
  }

  const records: EvaluationRecord[] = evaluateCandidates(classification, candidates, guardConfig, topK).map((ev) => ({
    imageId,
    articleId: ev.candidate.articleId,
    rank: ev.rank,
    classification,
    space,
    similarity: ev.candidate.similarity,
    decision: ev.result.decision,
    primaryReasonCode: ev.result.primaryReasonCode,
    reasons: ev.result.reasons,
    signals: ev.result.signals,
    policyVersion: ev.result.policyVersion,
    policyConfig: guardConfig,
  }));

  const saved = await store.saveEvaluations(records); // all-or-nothing
  const outcomes = { ...empty };
  for (const s of saved) outcomes[s.outcome] += 1;
  return { skipped: false, outcomes, evaluations: await store.listEvaluationsForImage(imageId) };
}
