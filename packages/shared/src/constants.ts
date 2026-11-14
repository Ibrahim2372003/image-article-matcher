/** Architectural constants shared by API, scripts and web. */
export const EMBEDDING_DIMENSION = 768;
export const EMBEDDING_MODEL = "gemini-embedding-001";
export const EMBEDDING_TASK_TYPE = "SEMANTIC_SIMILARITY";

export const DECISIONS = ["accept", "reject", "review"] as const;
export type Decision = (typeof DECISIONS)[number];

export const JOB_STATUSES = ["queued", "processing", "completed", "failed", "needs_review"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const REASON_CODES = {
  LOW_CLASSIFICATION_CONFIDENCE: "LOW_CLASSIFICATION_CONFIDENCE",
  BELOW_SIMILARITY_THRESHOLD: "BELOW_SIMILARITY_THRESHOLD",
  CATEGORY_MISMATCH: "CATEGORY_MISMATCH",
  AMBIGUOUS_MATCH: "AMBIGUOUS_MATCH",
} as const;
export type ReasonCode = (typeof REASON_CODES)[keyof typeof REASON_CODES];

export const MATCH_TOP_K = 3;
export const POLICY_VERSION = "guard-v1";

/**
 * Uncalibrated starting thresholds. They have NOT been measured against real
 * provider embeddings; calibrate with the evaluation command (see docs/policy.md).
 */
export const GUARD_DEFAULTS = {
  minConfidence: 0.5,
  minSimilarity: 0.6,
  minMargin: 0.02,
  minSharedTags: 1,
} as const;
