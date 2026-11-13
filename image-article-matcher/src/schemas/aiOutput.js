import { z } from "zod";

/**
 * The contract a vision-classification response must satisfy before
 * anything downstream trusts it ("strict structured output -> Zod
 * validation" in the pipeline). Provider-agnostic: nothing here
 * references Gemini; whatever calls a real model shapes its raw response
 * into this object first, so swapping providers never touches this file.
 *
 * `.strict()`: an unexpected extra field (model drift, a provider
 * wrapper key) is a validation failure, not silently dropped.
 *
 * `category` is an open short label rather than a fixed enum — the
 * taxonomy belongs to the corpus, not the schema.
 */
export const VisionClassificationOutputSchema = z
  .object({
    category: z.string().min(1, "category must not be empty").max(100, "category must be a short label, not free text"),
    tags: z
      .array(z.string().min(1, "a tag must not be an empty string").max(50, "a tag must be a short label, not free text"))
      .max(20, "no more than 20 tags"),
    confidence: z
      .number({ invalid_type_error: "confidence must be a number" })
      .min(0, "confidence must be >= 0")
      .max(1, "confidence must be <= 1"),
  })
  .strict();

export function formatVisionOutputError(zodError) {
  return zodError.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}
