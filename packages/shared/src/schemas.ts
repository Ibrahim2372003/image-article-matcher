import { z } from "zod";
import { DECISIONS, EMBEDDING_DIMENSION, JOB_STATUSES, REASON_CODES, type ReasonCode } from "./constants.js";

/** Relative server-side image path: no absolute paths, no '..', no backslashes. */
export const ImagePathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (p) =>
      !p.includes("\0") &&
      !p.includes("\\") &&
      !p.split("/").includes("..") &&
      !p.startsWith("/") &&
      !/^[A-Za-z]:/.test(p),
    "storagePath must be a relative path inside the images directory (no '..', no absolute paths, forward slashes only)",
  )
  .refine((p) => /\.(png|jpe?g|webp)$/i.test(p), "storagePath must end in .png, .jpg, .jpeg, or .webp");

export const ArticleInputSchema = z.object({
  title: z.string().trim().min(1).max(500),
  body: z.string().trim().min(1).max(50_000),
  category: z.string().trim().min(1).max(100).optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(30).default([]),
});
export type ArticleInput = z.infer<typeof ArticleInputSchema>;

/** Contract a vision classification must satisfy before anything downstream trusts it. */
export const VisionClassificationSchema = z
  .object({
    category: z.string().min(1).max(100),
    tags: z.array(z.string().min(1).max(50)).max(20),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type VisionClassification = z.infer<typeof VisionClassificationSchema>;

export const EmbeddingVectorSchema = z
  .array(z.number().finite())
  .length(EMBEDDING_DIMENSION, `embedding must have exactly ${EMBEDDING_DIMENSION} dimensions`);

export const ReviewInputSchema = z.object({
  reviewer: z.string().trim().min(1).max(100),
  decision: z.enum(["approved", "rejected"]),
  notes: z.string().trim().min(1, "reasoning (notes) is required for every review").max(2000),
});
export type ReviewInput = z.infer<typeof ReviewInputSchema>;

export const DecisionSchema = z.enum(DECISIONS);
export const JobStatusSchema = z.enum(JOB_STATUSES);

/** Consistent API envelopes. */
export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const HealthSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  version: z.string(),
  uptimeSeconds: z.number(),
});
export type Health = z.infer<typeof HealthSchema>;

export function formatZodError(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/** API contract for submitted jobs (milestone 5). Timestamps are ISO-8601 strings. */
export const JobReasonSchema = z.object({
  code: z.enum(Object.values(REASON_CODES) as [ReasonCode, ...ReasonCode[]]),
  severity: z.enum(["review", "reject"]),
  explanation: z.string(),
  signals: z.record(z.unknown()),
});

export const JobUsageSummarySchema = z.object({
  /** Real provider calls only; results reused from earlier attempts create no usage. */
  calls: z.number().int().nonnegative(),
  failedCalls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  tokensEstimated: z.boolean(),
  /** Sum of KNOWN call costs only; null when no call has a known cost. Never an invented price. */
  estimatedCostUsd: z.number().nonnegative().nullable(),
  /** false when at least one call's cost is unknown, i.e. estimatedCostUsd (if any) is a lower bound. */
  costComplete: z.boolean(),
});
export type JobUsageSummary = z.infer<typeof JobUsageSummarySchema>;

export const JobViewSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal("submission"),
  status: JobStatusSchema,
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  articleId: z.string().uuid(),
  imageId: z.string().uuid(),
  /** null unless the guard produced a decision. A failed job NEVER has a decision. */
  decision: DecisionSchema.nullable(),
  similarity: z.number().nullable(),
  reasons: z.array(JobReasonSchema),
  signals: z.record(z.unknown()).nullable(),
  policyVersion: z.string().nullable(),
  embeddingModel: z.string().nullable(),
  classification: VisionClassificationSchema.nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  usage: JobUsageSummarySchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});
export type JobView = z.infer<typeof JobViewSchema>;

export const JobSubmissionResponseSchema = z.object({ job: JobViewSchema, replayed: z.boolean() });
export type JobSubmissionResponse = z.infer<typeof JobSubmissionResponseSchema>;
