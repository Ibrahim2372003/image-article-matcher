import { EmbeddingVectorSchema, formatEmbeddingError } from "../schemas/embeddingOutput.js";
import { PermanentError } from "../ai/errors.js";
import { trackModelCall } from "./costTracker.js";

const MAX_ARTICLE_CHARS = 6000;

/** An image is embedded from its structured classification metadata, never from raw pixels. */
export function buildImageEmbeddingText(classification) {
  return `category: ${classification.category}; tags: ${classification.tags.join(", ")}`;
}

/** An article is embedded from its title + body (truncated to stay within the model's input limit). */
export function buildArticleEmbeddingText(article, maxChars = MAX_ARTICLE_CHARS) {
  return `${article.title}\n\n${article.body}`.slice(0, maxChars);
}

/**
 * text -> embedding call -> dimension check -> persisted vector (+ a
 * model_calls row). Idempotent: an owner that already has an embedding
 * is skipped without an AI call.
 */
export async function embedOwner({ store, provider, ownerType, ownerId, text, now = () => new Date() }) {
  if (await store.hasEmbedding(ownerType, ownerId)) return { skipped: true };

  const startedAt = now();
  const base = { provider: provider.name, operation: "embed", startedAt };

  let result;
  try {
    result = await provider.embedText(text);
  } catch (err) {
    await trackModelCall(store, {
      ...base,
      model: provider.embeddingModel ?? "unknown",
      finishedAt: now(),
      usage: err.usage ?? null,
      success: false,
      errorMessage: err.message,
    });
    throw err;
  }

  const parsed = EmbeddingVectorSchema.safeParse(result.vector);
  if (!parsed.success) {
    const message = `invalid embedding: ${formatEmbeddingError(parsed.error)}`;
    await trackModelCall(store, { ...base, model: result.model, finishedAt: now(), usage: result.usage, success: false, errorMessage: message });
    // A wrong dimension is a model/configuration mismatch; retrying cannot fix it.
    throw new PermanentError(message);
  }

  const modelCallId = await trackModelCall(store, { ...base, model: result.model, finishedAt: now(), usage: result.usage, success: true });
  await store.upsertEmbedding({ ownerType, ownerId, vector: parsed.data, model: result.model, modelCallId });
  return { skipped: false };
}

export async function embedImage({ store, provider, imageId, now }) {
  const image = await store.getImage(imageId);
  if (!image) throw new PermanentError(`image ${imageId} not found`);
  const classification = await store.getLatestClassification(imageId);
  if (!classification) throw new PermanentError(`image ${imageId} has no classification to embed`);
  const outcome = await embedOwner({ store, provider, ownerType: "image", ownerId: imageId, text: buildImageEmbeddingText(classification), now });
  await store.setImageStatus(imageId, "embedded");
  return outcome;
}

export async function embedArticle({ store, provider, articleId, now }) {
  const article = await store.getArticle(articleId);
  if (!article) throw new PermanentError(`article ${articleId} not found`);
  const outcome = await embedOwner({ store, provider, ownerType: "article", ownerId: articleId, text: buildArticleEmbeddingText(article), now });
  await store.setArticleStatus(articleId, "embedded");
  return outcome;
}
