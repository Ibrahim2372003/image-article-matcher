import type { Decision, ReasonCode } from "@iam/shared";
import type { GuardConfig, GuardReason, GuardSignals } from "./guard.js";
import type { Candidate } from "./ranking.js";

export interface ImageRow {
  id: string;
  storagePath: string;
}
export interface ArticleRow {
  id: string;
  title: string;
  body: string;
  category: string | null;
  tags: string[];
}
export interface StoredClassification {
  category: string;
  tags: string[];
  confidence: number;
  provider: string;
  model: string;
}

/** Vectors are only comparable when BOTH the model and the task type match. */
export interface EmbeddingSpace {
  model: string;
  taskType: string;
}
export const sameSpace = (a: EmbeddingSpace, b: EmbeddingSpace): boolean =>
  a.model === b.model && a.taskType === b.taskType;
export const describeSpace = (s: EmbeddingSpace): string => `${s.model}/${s.taskType}`;

export interface EvaluationRecord {
  imageId: string;
  articleId: string;
  rank: number;
  classification: StoredClassification;
  space: EmbeddingSpace;
  similarity: number;
  decision: Decision;
  primaryReasonCode: ReasonCode | null;
  reasons: GuardReason[];
  signals: GuardSignals;
  policyVersion: string;
  policyConfig: GuardConfig;
}

/** created: new row; updated: re-evaluated an unreviewed row; preserved: a human review exists, row untouched. */
export type SaveOutcome = "created" | "updated" | "preserved";

export interface PairContext {
  /** Cosine similarity of the target; NaN when a vector is degenerate (the guard rejects non-finite scores). */
  similarity: number;
  /** 1 = best article for this image. */
  rank: number;
  /** Best similarity among the OTHER articles, or null when the target is the only article in the space. */
  bestOtherSimilarity: number | null;
}

export interface SavedEvaluation {
  articleId: string;
  jobId: string;
  outcome: SaveOutcome;
}

export interface StoredEvaluation {
  jobId: string;
  articleId: string;
  status: string;
  decision: Decision | null;
  similarity: number | null;
  rank: number | null;
  reasons: GuardReason[];
  hasReview: boolean;
}

/** Persistence boundary for matching. Unit tests use an in-memory fake; production uses `PgMatchStore`. */
export interface MatchStore {
  getImage(imageId: string): Promise<ImageRow | null>;
  getArticle(articleId: string): Promise<ArticleRow | null>;
  getLatestClassification(imageId: string): Promise<StoredClassification | null>;
  upsertClassification(imageId: string, c: StoredClassification, rawOutput: unknown): Promise<void>;
  listImageEmbeddingSpaces(imageId: string): Promise<EmbeddingSpace[]>;
  listArticleEmbeddingSpaces(): Promise<EmbeddingSpace[]>;
  listEmbeddingSpacesForArticle(articleId: string): Promise<EmbeddingSpace[]>;
  hasImageEmbedding(imageId: string, space: EmbeddingSpace): Promise<boolean>;
  hasArticleEmbedding(articleId: string, space: EmbeddingSpace): Promise<boolean>;
  upsertImageEmbedding(imageId: string, vector: number[], space: EmbeddingSpace): Promise<void>;
  upsertArticleEmbedding(articleId: string, vector: number[], space: EmbeddingSpace): Promise<void>;
  /** Nearest articles to the image by cosine similarity, restricted to embeddings in the SAME space. */
  findNearestArticles(imageId: string, space: EmbeddingSpace, limit: number): Promise<Candidate[]>;
  /**
   * Exact similarity, rank and runner-up for ONE target article against the image, in one embedding space. Ranking
   * is over every article embedded in that space (NaN scores excluded), ties broken by article id, which is the
   * same order the top-K ranking uses. Returns null when the target has no embedding in the space.
   */
  getPairContext(imageId: string, articleId: string, space: EmbeddingSpace): Promise<PairContext | null>;
  hasEvaluations(imageId: string): Promise<boolean>;
  /** ALL records are persisted in one transaction or none are. Returned in the same order as `records`. */
  saveEvaluations(records: EvaluationRecord[]): Promise<SavedEvaluation[]>;
  listEvaluationsForImage(imageId: string): Promise<StoredEvaluation[]>;
}

/** Idempotency key for a match result: one row per (image, article) pair. */
export const suggestionKey = (imageId: string, articleId: string): string => `suggest:${imageId}:${articleId}`;
export const suggestionKeyPrefix = (imageId: string): string => `suggest:${imageId}:`;

/** Cosine similarity from pgvector can land a hair outside [-1, 1]; non-finite values cannot be stored. */
export function toStorableSimilarity(x: number): number | null {
  return Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : null;
}
