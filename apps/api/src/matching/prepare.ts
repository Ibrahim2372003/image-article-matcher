import { EMBEDDING_TASK_TYPE } from "@iam/shared";
import { classifyImageValidated, embedTextValidated, type AiProvider, type ImageMimeType } from "../ai/index.js";
import { ArticleNotFoundError, ImageNotFoundError, MissingPrerequisiteError } from "./errors.js";
import type { EmbeddingSpace, MatchStore, StoredClassification } from "./types.js";

const MAX_ARTICLE_CHARS = 6000; // stays inside gemini-embedding-001's ~2,048-token input limit

/** Images are embedded from their validated classification metadata, never from raw pixels. */
export function buildImageEmbeddingText(c: Pick<StoredClassification, "category" | "tags">): string {
  return `category: ${c.category}; tags: ${c.tags.join(", ")}`;
}
export function buildArticleEmbeddingText(a: { title: string; body: string }, maxChars = MAX_ARTICLE_CHARS): string {
  return `${a.title}\n\n${a.body}`.slice(0, maxChars);
}

export type LoadImage = (storagePath: string) => Promise<{ base64: string; mimeType: ImageMimeType }>;

interface Ctx {
  store: MatchStore;
  provider: AiProvider;
}

/** Classifies the image with the provider (validated) unless a classification from this provider/model exists. */
export async function ensureImageClassification(
  args: Ctx & { imageId: string; loadImage: LoadImage },
): Promise<StoredClassification> {
  const { store, provider, imageId } = args;
  const image = await store.getImage(imageId);
  if (!image) throw new ImageNotFoundError(imageId);
  const existing = await store.getLatestClassification(imageId);
  if (existing && existing.provider === provider.name && existing.model === provider.visionModel) return existing;
  const loaded = await args.loadImage(image.storagePath);
  const r = await classifyImageValidated(provider, { ...loaded, imageRef: image.storagePath });
  const stored: StoredClassification = { ...r.classification, provider: r.provider, model: r.model };
  await store.upsertClassification(imageId, stored, r.rawOutput);
  return stored;
}

/** Embeds the image's classification text in the provider's embedding space unless that embedding exists. */
export async function ensureImageEmbedding(
  args: Ctx & { imageId: string },
): Promise<{ space: EmbeddingSpace; created: boolean }> {
  const { store, provider, imageId } = args;
  if (!(await store.getImage(imageId))) throw new ImageNotFoundError(imageId);
  const wanted: EmbeddingSpace = { model: provider.embeddingModel, taskType: EMBEDDING_TASK_TYPE };
  if (await store.hasImageEmbedding(imageId, wanted)) return { space: wanted, created: false };
  const classification = await store.getLatestClassification(imageId);
  if (!classification)
    throw new MissingPrerequisiteError(
      "classification",
      `image ${imageId} must be classified before it can be embedded`,
    );
  const r = await embedTextValidated(provider, buildImageEmbeddingText(classification), { taskType: wanted.taskType });
  const space: EmbeddingSpace = { model: r.model, taskType: wanted.taskType };
  await store.upsertImageEmbedding(imageId, r.vector, space);
  return { space, created: true };
}

/** Embeds the article text in the provider's embedding space unless that embedding exists. */
export async function ensureArticleEmbedding(
  args: Ctx & { articleId: string },
): Promise<{ space: EmbeddingSpace; created: boolean }> {
  const { store, provider, articleId } = args;
  const article = await store.getArticle(articleId);
  if (!article) throw new ArticleNotFoundError(articleId);
  const wanted: EmbeddingSpace = { model: provider.embeddingModel, taskType: EMBEDDING_TASK_TYPE };
  if (await store.hasArticleEmbedding(articleId, wanted)) return { space: wanted, created: false };
  const r = await embedTextValidated(provider, buildArticleEmbeddingText(article), { taskType: wanted.taskType });
  const space: EmbeddingSpace = { model: r.model, taskType: wanted.taskType };
  await store.upsertArticleEmbedding(articleId, r.vector, space);
  return { space, created: true };
}
