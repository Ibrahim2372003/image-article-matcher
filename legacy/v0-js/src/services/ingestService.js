/**
 * Create-or-find an image and queue its classification when needed.
 * Idempotent: re-submitting an existing image does not duplicate it or
 * its jobs — except a previously FAILED image, which is reset to
 * "pending" and re-queued (the retry path).
 */
export async function submitImage(store, data) {
  const { image, created } = await store.createImage(data);
  let enqueued = created;
  if (!created && image.status === "failed") {
    await store.setImageStatus(image.id, "pending");
    image.status = "pending";
    enqueued = true;
  }
  if (enqueued) await store.enqueueJob("classify_image", { imageId: image.id });
  return { image, created, enqueued };
}

export async function submitArticle(store, data) {
  const { article, created } = await store.createArticle(data);
  let enqueued = created;
  if (!created && article.status === "failed") {
    await store.setArticleStatus(article.id, "pending");
    article.status = "pending";
    enqueued = true;
  }
  if (enqueued) await store.enqueueJob("embed_article", { articleId: article.id });
  return { article, created, enqueued };
}
