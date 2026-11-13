import path from "node:path";
import { z } from "zod";

/**
 * A server-side image path, relative to IMAGES_DIR. Rejected up front:
 * absolute paths, `..` segments, backslashes, anything that isn't an
 * image extension. (imageLoader.js re-checks the resolved path against
 * the images root — this is the first line of defence, not the only one.)
 */
export const ImagePathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (p) => !p.includes("\0") && !p.includes("\\") && !p.split("/").includes("..") && !path.posix.isAbsolute(p) && !path.win32.isAbsolute(p),
    "storagePath must be a relative path inside the images directory (no '..', no absolute paths, forward slashes only)"
  )
  .refine((p) => /\.(png|jpe?g|webp)$/i.test(p), "storagePath must end in .png, .jpg, .jpeg, or .webp");

export const ImageCreateSchema = z.object({
  storagePath: ImagePathSchema,
  originalFilename: z.string().max(255).optional(),
  categoryHint: z.string().max(100).optional(),
});

export const ArticleCreateSchema = z.object({
  title: z.string().min(1).max(500),
  body: z.string().min(1).max(50000),
  category: z.string().min(1).max(100).optional(),
  tags: z.array(z.string().min(1).max(50)).max(30).optional().default([]),
});

export const ReviewCreateSchema = z.object({
  reviewer: z.string().trim().min(1).max(100),
  decision: z.enum(["approved", "rejected"]),
  notes: z.string().trim().min(1, "reasoning (notes) is required for every review").max(2000),
});

export const ClassificationRecordSchema = z.object({
  imageId: z.number().int().positive(),
  category: z.string().min(1),
  tags: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  modelCallId: z.number().int().positive(),
});

export const MatchingSuggestionSchema = z.object({
  imageId: z.number().int().positive(),
  articleId: z.number().int().positive(),
  similarityScore: z.number(),
  rank: z.number().int().positive(),
  decision: z.enum(["match", "reject"]),
});

// Signal values are the numeric/boolean/string facts the guard evaluated
// — a record of JSON scalars, never an open `any`.
const JsonScalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const MismatchReasonSchema = z.object({
  suggestionId: z.number().int().positive(),
  reasonCode: z.string().min(1),
  humanExplanation: z.string().min(1),
  signalValues: z.record(JsonScalar),
});

export function formatZodError(zodError) {
  return zodError.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}
