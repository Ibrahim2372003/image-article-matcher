/**
 * Central configuration. The embedding dimension is a locked
 * architectural decision kept in exactly one place at runtime:
 * Google's `gemini-embedding-001` with `outputDimensionality: 768`.
 * The migration necessarily hardcodes `VECTOR(768)` in SQL (pgvector
 * needs a fixed column width); a test asserts the migration and this
 * constant agree so they cannot silently drift apart.
 */
export const EMBEDDING_DIMENSION = 768;
export const EMBEDDING_MODEL = "gemini-embedding-001";
export const EMBEDDING_TASK_TYPE = "SEMANTIC_SIMILARITY";

// Model names are env-configurable on purpose: Google retires models on
// a schedule (third-party sources report the 2.0 family shut down
// June 1, 2026 and 2.5 Flash-Lite retires Oct 16, 2026 — NOT verified
// against Google directly). This default is NOT VERIFIED as currently
// available; set GEMINI_VISION_MODEL to a model your account lists.
export const DEFAULT_VISION_MODEL = "gemini-2.5-flash";
export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Published per-1M-token rates used ONLY to compute an ESTIMATED cost.
 * Taken from third-party pricing roundups, not Google's own page, and
 * therefore NOT VERIFIED. A model absent from this table gets a NULL
 * estimate (cost_basis = 'no_rate_configured') — a cost is never
 * invented. These are what a PAID call would cost; under Google AI
 * Studio's free tier the real bill is expected to be $0, but this app
 * cannot verify billing state, so it never claims a call was free.
 */
export const PRICING_PER_1M_TOKENS_USD = {
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5 },
  "gemini-embedding-001": { input: 0.15, output: 0 },
};

// Mismatch Guard defaults — UNCALIBRATED starting points. Real Gemini
// embedding similarities were never measured in this environment
// (Gemini is unreachable here). Calibrate with `npm run eval:gemini`.
export const GUARD_DEFAULTS = {
  minConfidence: 0.5,
  minSimilarity: 0.6,
  minMargin: 0.02,
  minSharedTags: 1,
};

export function loadGuardConfig(env = process.env) {
  const num = (value, fallback) =>
    value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : fallback;
  return {
    minConfidence: num(env.GUARD_MIN_CONFIDENCE, GUARD_DEFAULTS.minConfidence),
    minSimilarity: num(env.GUARD_MIN_SIMILARITY, GUARD_DEFAULTS.minSimilarity),
    minMargin: num(env.GUARD_MIN_MARGIN, GUARD_DEFAULTS.minMargin),
    minSharedTags: num(env.GUARD_MIN_SHARED_TAGS, GUARD_DEFAULTS.minSharedTags),
  };
}

export const JOB_DEFAULTS = {
  batchSize: 5,
  maxAttempts: 3,
  pollIntervalMs: 1000,
  backoffBaseMs: 5000,
  backoffMaxMs: 300000,
  visibilityTimeoutMs: 300000,
};

export function loadJobConfig(env = process.env) {
  const num = (value, fallback) =>
    value !== undefined && value !== "" && Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
  return {
    ...JOB_DEFAULTS,
    batchSize: num(env.JOB_BATCH_SIZE, JOB_DEFAULTS.batchSize),
    maxAttempts: num(env.JOB_MAX_ATTEMPTS, JOB_DEFAULTS.maxAttempts),
    pollIntervalMs: num(env.JOB_POLL_INTERVAL_MS, JOB_DEFAULTS.pollIntervalMs),
  };
}

export const MATCH_TOP_K = 3;
