import { z } from "zod";
import { GUARD_DEFAULTS, POLICY_VERSION, REASON_CODES, type Decision, type ReasonCode } from "@iam/shared";
import { GuardInputError, MatchingError } from "./errors.js";

/** Thresholds, validated. NaN/Infinity/out-of-range values are rejected instead of weakening the guard. */
export const GuardConfigSchema = z
  .object({
    minConfidence: z.number().finite().min(0).max(1),
    minSimilarity: z.number().finite().min(-1).max(1),
    /** Required gap between the best candidate and the runner-up. 0 effectively disables the ambiguity rule. */
    minMargin: z.number().finite().min(0).max(2),
    minSharedTags: z.number().int().min(0).max(100),
  })
  .strict();
export type GuardConfig = z.infer<typeof GuardConfigSchema>;

export function resolveGuardConfig(overrides: Partial<GuardConfig> = {}): GuardConfig {
  const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
  const parsed = GuardConfigSchema.safeParse({ ...GUARD_DEFAULTS, ...defined });
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new MatchingError("invalid_input", `Invalid guard configuration: ${msg}`);
  }
  return parsed.data;
}

/** Reasons that only mean "a human should look" vs. reasons that mean "this pairing is wrong". */
export type ReasonSeverity = "review" | "reject";
export const REASON_SEVERITY: Readonly<Record<ReasonCode, ReasonSeverity>> = {
  LOW_CLASSIFICATION_CONFIDENCE: "review",
  BELOW_SIMILARITY_THRESHOLD: "reject",
  CATEGORY_MISMATCH: "reject",
  AMBIGUOUS_MATCH: "review",
};
/** Evaluation / reporting order. */
const PRIORITY: readonly ReasonCode[] = [
  REASON_CODES.LOW_CLASSIFICATION_CONFIDENCE,
  REASON_CODES.BELOW_SIMILARITY_THRESHOLD,
  REASON_CODES.CATEGORY_MISMATCH,
  REASON_CODES.AMBIGUOUS_MATCH,
];

export interface GuardReason {
  code: ReasonCode;
  severity: ReasonSeverity;
  explanation: string;
  signals: Record<string, unknown>;
}

export interface GuardSignals {
  confidence: number;
  similarity: number;
  rank: number;
  margin: number | null;
  sharedTagCount: number;
  imageCategory: string;
  articleCategory: string;
}

export interface GuardResult {
  decision: Decision;
  primaryReasonCode: ReasonCode | null;
  reasons: GuardReason[];
  signals: GuardSignals;
  policyVersion: string;
}

export interface GuardInput {
  classification: { category?: unknown; tags?: unknown; confidence: number };
  article: { category?: unknown; tags?: unknown };
  /** Cosine similarity between the image and article embeddings (same embedding model). */
  similarity: number;
  /** 1 = best candidate for this image. */
  rank: number;
  /** Similarity of the runner-up, or null/undefined when there is none. */
  nextSimilarity?: number | null | undefined;
}

/** Trim, NFKC-normalise, collapse whitespace, lowercase. Non-strings become "". */
export function normalizeLabel(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Normalised, de-duplicated, order-preserving; anything that is not an array of strings yields []. */
export function normalizeLabels(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const v of values) {
    const n = normalizeLabel(v);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

const SIMILARITY_EPSILON = 1e-6; // float rounding in vector arithmetic can yield 1.0000001
const isConfidence = (x: number): boolean => Number.isFinite(x) && x >= 0 && x <= 1;
const isSimilarity = (x: number): boolean => Number.isFinite(x) && Math.abs(x) <= 1 + SIMILARITY_EPSILON;
const fmt = (n: number | null, digits = 2): string =>
  n !== null && Number.isFinite(n) ? n.toFixed(digits) : String(n);

/**
 * The Mismatch Guard: PURE and deterministic. No AI, no network, no clock. Every rule is evaluated and
 * every failing rule is reported. Numeric checks use `!(valid && x >= min)` so NaN/out-of-range values
 * FAIL a rule instead of slipping past it. Structurally invalid arguments (bad rank, non-number scores)
 * throw `GuardInputError`; callers must treat that as a failure, never as an approval.
 */
export function evaluateMatch(input: GuardInput, config: GuardConfig = resolveGuardConfig()): GuardResult {
  const cfg = GuardConfigSchema.parse(config);
  const { classification, article, similarity, rank } = input;
  if (!Number.isInteger(rank) || rank < 1)
    throw new GuardInputError(`rank must be a positive integer, got ${String(rank)}`);
  for (const [name, v] of [
    ["classification.confidence", classification.confidence],
    ["similarity", similarity],
  ] as const) {
    if (typeof v !== "number") throw new GuardInputError(`${name} must be a number, got ${typeof v}`);
  }
  const next = input.nextSimilarity;
  if (next !== null && next !== undefined && typeof next !== "number")
    throw new GuardInputError("nextSimilarity must be a number or null");

  const confidence = classification.confidence;
  const imageCategory = normalizeLabel(classification.category);
  const articleCategory = normalizeLabel(article.category);
  const imageTags = normalizeLabels(classification.tags);
  const articleTags = new Set(normalizeLabels(article.tags));
  const sharedTagCount = imageTags.filter((t) => articleTags.has(t)).length;
  const hasRunnerUp = next !== null && next !== undefined;
  const margin = hasRunnerUp ? similarity - next : null;

  const found = new Map<ReasonCode, Omit<GuardReason, "code" | "severity">>();

  if (!(isConfidence(confidence) && confidence >= cfg.minConfidence)) {
    found.set("LOW_CLASSIFICATION_CONFIDENCE", {
      explanation: isConfidence(confidence)
        ? `The vision model's confidence in its classification (${fmt(confidence)}) is below the required minimum of ${fmt(cfg.minConfidence)}, so the image's metadata is too uncertain to base a match on.`
        : `The classification confidence (${String(confidence)}) is not a valid number between 0 and 1, so the image's metadata cannot be trusted.`,
      signals: { confidence, minConfidence: cfg.minConfidence, valid: isConfidence(confidence) },
    });
  }

  if (!(isSimilarity(similarity) && similarity >= cfg.minSimilarity)) {
    found.set("BELOW_SIMILARITY_THRESHOLD", {
      explanation: isSimilarity(similarity)
        ? `The image and article are not semantically close enough: cosine similarity ${fmt(similarity)} is below the required minimum of ${fmt(cfg.minSimilarity)}.`
        : `The similarity score (${String(similarity)}) is not a valid cosine similarity, so the pairing cannot be accepted.`,
      signals: { similarity, minSimilarity: cfg.minSimilarity, valid: isSimilarity(similarity) },
    });
  }

  if (imageCategory && articleCategory && imageCategory !== articleCategory && sharedTagCount < cfg.minSharedTags) {
    found.set("CATEGORY_MISMATCH", {
      explanation: `The image category "${imageCategory}" differs from the article category "${articleCategory}", and they share ${sharedTagCount} tag(s), fewer than the ${cfg.minSharedTags} required to treat the topics as compatible.`,
      signals: { imageCategory, articleCategory, sharedTagCount, minSharedTags: cfg.minSharedTags },
    });
  }

  if (rank === 1 && hasRunnerUp && !(margin !== null && Number.isFinite(margin) && margin >= cfg.minMargin)) {
    found.set("AMBIGUOUS_MATCH", {
      explanation: `The best candidate (similarity ${fmt(similarity)}) beats the runner-up (${fmt(next)}) by ${fmt(margin, 3)}, less than the required margin of ${fmt(cfg.minMargin, 3)}, so the match is too close to call automatically.`,
      signals: { similarity, nextSimilarity: next, margin, minMargin: cfg.minMargin },
    });
  }

  const reasons: GuardReason[] = PRIORITY.flatMap((code) => {
    const r = found.get(code);
    return r ? [{ code, severity: REASON_SEVERITY[code], ...r }] : [];
  });
  const decision: Decision = reasons.some((r) => r.severity === "reject")
    ? "reject"
    : reasons.length > 0
      ? "review"
      : "accept";
  // The primary reason is the first one that actually determines the decision.
  const primary = reasons.find((r) => r.severity === decision) ?? null;

  return {
    decision,
    primaryReasonCode: primary?.code ?? null,
    reasons,
    signals: { confidence, similarity, rank, margin, sharedTagCount, imageCategory, articleCategory },
    policyVersion: POLICY_VERSION,
  };
}

/** Guard thresholds from validated env overrides; unset values keep the documented defaults. */
export function guardConfigFromEnv(env: {
  GUARD_MIN_CONFIDENCE?: number | undefined;
  GUARD_MIN_SIMILARITY?: number | undefined;
  GUARD_MIN_MARGIN?: number | undefined;
  GUARD_MIN_SHARED_TAGS?: number | undefined;
}): GuardConfig {
  return resolveGuardConfig({
    minConfidence: env.GUARD_MIN_CONFIDENCE,
    minSimilarity: env.GUARD_MIN_SIMILARITY,
    minMargin: env.GUARD_MIN_MARGIN,
    minSharedTags: env.GUARD_MIN_SHARED_TAGS,
  });
}
