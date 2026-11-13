import { z } from "zod";
import { PermanentError } from "../ai/errors.js";
import { classifyImage } from "../services/classificationService.js";
import { embedImage, embedArticle } from "../services/embeddingService.js";
import { generateMatches } from "../services/matchingService.js";
import { isPermanentFailure } from "./worker.js";

const ImagePayload = z.object({ imageId: z.number().int().positive() });
const ArticlePayload = z.object({ articleId: z.number().int().positive() });
const MatchPayload = z.object({ imageId: z.number().int().positive(), force: z.boolean().optional() });

function parsePayload(schema, payload) {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new PermanentError(`invalid job payload: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

/**
 * Job pipeline:
 *   classify_image -> embed_image -> generate_matches   (per image)
 *   embed_article                                       (per article)
 * Each handler is idempotent (the services skip work already done), so
 * at-least-once delivery — retries, a crash between "work done" and
 * "job marked done" — can never double-spend an AI call or duplicate a
 * row. On a PERMANENT failure the entity's own status becomes "failed"
 * so the outcome is visible without reading the jobs table.
 */
export function createHandlers({ store, provider, loadImage, guardConfig, now = () => new Date() }) {
  const markImageFailed = async (imageId, err, ctx) => {
    if (isPermanentFailure(err, ctx)) await store.setImageStatus(imageId, "failed").catch(() => {});
  };
  const markArticleFailed = async (articleId, err, ctx) => {
    if (isPermanentFailure(err, ctx)) await store.setArticleStatus(articleId, "failed").catch(() => {});
  };

  return {
    classify_image: async (payload, ctx) => {
      const { imageId } = parsePayload(ImagePayload, payload);
      try {
        await classifyImage({ store, provider, imageId, loadImage, now });
        await store.enqueueJob("embed_image", { imageId });
      } catch (err) {
        await markImageFailed(imageId, err, ctx);
        throw err;
      }
    },
    embed_image: async (payload, ctx) => {
      const { imageId } = parsePayload(ImagePayload, payload);
      try {
        await embedImage({ store, provider, imageId, now });
        await store.enqueueJob("generate_matches", { imageId });
      } catch (err) {
        await markImageFailed(imageId, err, ctx);
        throw err;
      }
    },
    embed_article: async (payload, ctx) => {
      const { articleId } = parsePayload(ArticlePayload, payload);
      try {
        await embedArticle({ store, provider, articleId, now });
      } catch (err) {
        await markArticleFailed(articleId, err, ctx);
        throw err;
      }
    },
    generate_matches: async (payload, ctx) => {
      const { imageId, force } = parsePayload(MatchPayload, payload);
      try {
        await generateMatches({ store, imageId, guardConfig, force: force === true });
      } catch (err) {
        await markImageFailed(imageId, err, ctx);
        throw err;
      }
    },
  };
}
