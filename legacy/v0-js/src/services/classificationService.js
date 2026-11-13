import { VisionClassificationOutputSchema, formatVisionOutputError } from "../schemas/aiOutput.js";
import { OutputValidationError, PermanentError } from "../ai/errors.js";
import { trackModelCall } from "./costTracker.js";

/**
 * image -> vision call -> strict Zod validation -> persisted
 * classification (+ a model_calls row for EVERY attempt, valid or not).
 *
 * Idempotent: if the image already has a classification, no AI call is
 * made (a retried or duplicated job costs nothing and cannot create a
 * second classification row).
 */
export async function classifyImage({ store, provider, imageId, loadImage, now = () => new Date() }) {
  const image = await store.getImage(imageId);
  if (!image) throw new PermanentError(`image ${imageId} not found`);

  const existing = await store.getLatestClassification(imageId);
  if (existing) return existing;

  const loaded = await loadImage(image.storagePath);
  const startedAt = now();
  const base = { provider: provider.name, operation: "vision_classify", startedAt };

  let result;
  try {
    result = await provider.classifyImage({ imagePath: image.storagePath, base64: loaded.base64, mimeType: loaded.mimeType });
  } catch (err) {
    await trackModelCall(store, {
      ...base,
      model: provider.visionModel ?? "unknown",
      finishedAt: now(),
      usage: err.usage ?? null,
      success: false,
      errorMessage: err.message,
    });
    throw err;
  }

  const parsed = VisionClassificationOutputSchema.safeParse(result.rawOutput);
  if (!parsed.success) {
    const message = `invalid structured output: ${formatVisionOutputError(parsed.error)}`;
    // The call happened and tokens were spent even though the output is
    // unusable, so it is still cost-tracked — as a failure.
    await trackModelCall(store, { ...base, model: result.model, finishedAt: now(), usage: result.usage, success: false, errorMessage: message });
    throw new OutputValidationError(message, { usage: result.usage });
  }

  const modelCallId = await trackModelCall(store, { ...base, model: result.model, finishedAt: now(), usage: result.usage, success: true });
  const classification = await store.insertClassification({
    imageId,
    category: parsed.data.category,
    tags: parsed.data.tags,
    confidence: parsed.data.confidence,
    rawModelOutput: result.rawOutput,
    modelCallId,
  });
  await store.setImageStatus(imageId, "classified");
  return classification;
}
