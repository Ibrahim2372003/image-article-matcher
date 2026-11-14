import {
  EmbeddingVectorSchema,
  VisionClassificationSchema,
  formatZodError,
  type VisionClassification,
} from "@iam/shared";
import { InvalidClassificationError, InvalidEmbeddingError, ProviderInputError } from "./errors.js";
import {
  IMAGE_MIME_TYPES,
  type AiProvider,
  type ClassifyImageInput,
  type EmbedTextOptions,
  type ProviderUsage,
} from "./types.js";

export interface ValidatedClassification {
  classification: VisionClassification;
  /** The unmodified model output, kept for auditing alongside the validated copy. */
  rawOutput: unknown;
  usage: ProviderUsage;
  model: string;
  provider: string;
}

export interface ValidatedEmbedding {
  vector: number[];
  usage: ProviderUsage;
  model: string;
  provider: string;
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Calls the provider, then validates its output with the shared schema. Any failure throws. */
export async function classifyImageValidated(
  provider: AiProvider,
  input: ClassifyImageInput,
): Promise<ValidatedClassification> {
  if (!(IMAGE_MIME_TYPES as readonly string[]).includes(input.mimeType)) {
    throw new ProviderInputError(`Unsupported image mime type (allowed: ${IMAGE_MIME_TYPES.join(", ")})`);
  }
  if (input.base64.length === 0 || !BASE64_RE.test(input.base64)) {
    throw new ProviderInputError("Image must be non-empty base64 without a data: prefix");
  }

  const result = await provider.classifyImage(input);
  const parsed = VisionClassificationSchema.safeParse(result.rawOutput);
  if (!parsed.success) {
    // Only the validation summary is reported, not the raw model output (it may echo untrusted text).
    throw new InvalidClassificationError(`invalid structured output: ${formatZodError(parsed.error)}`, result.usage);
  }
  return {
    classification: parsed.data,
    rawOutput: result.rawOutput,
    usage: result.usage,
    model: result.model,
    provider: provider.name,
  };
}

/** Calls the provider, then enforces `EmbeddingVectorSchema` (768 finite numbers). Never pads or truncates. */
export async function embedTextValidated(
  provider: AiProvider,
  text: string,
  options?: EmbedTextOptions,
): Promise<ValidatedEmbedding> {
  if (text.trim().length === 0) throw new ProviderInputError("Text to embed must not be empty");

  const result = await provider.embedText(text, options);
  const parsed = EmbeddingVectorSchema.safeParse(result.vector);
  if (!parsed.success) {
    const got = Array.isArray(result.vector) ? ` (provider returned ${result.vector.length} values)` : "";
    throw new InvalidEmbeddingError(
      `invalid embedding from ${provider.name}/${result.model}: ${formatZodError(parsed.error)}${got}`,
      result.usage,
    );
  }
  return { vector: parsed.data, usage: result.usage, model: result.model, provider: provider.name };
}
