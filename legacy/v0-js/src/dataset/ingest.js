import { readFileSync } from "node:fs";
import { submitArticle, submitImage } from "../services/ingestService.js";

export const DEFAULT_MANIFEST_PATH = new URL("../../eval/dataset/manifest.json", import.meta.url);

export function loadManifest(path = DEFAULT_MANIFEST_PATH) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

/** storagePath -> the deterministic classification the MOCK provider returns for it. Test-double input only. */
export function manifestClassifications(manifest) {
  const out = {};
  for (const image of manifest.images) out[image.storagePath] = image.mockClassification;
  return out;
}

/** Idempotent: re-running does not duplicate rows or jobs. Returns Map(key -> article id). */
export async function ingestArticles(store, manifest) {
  const ids = new Map();
  for (const a of manifest.articles) {
    const { article } = await submitArticle(store, { title: a.title, body: a.body, category: a.category, tags: a.tags });
    ids.set(a.key, article.id);
  }
  return ids;
}

/** Returns Map(storagePath -> image id). */
export async function ingestImages(store, manifest) {
  const ids = new Map();
  for (const img of manifest.images) {
    const { image } = await submitImage(store, {
      storagePath: img.storagePath,
      originalFilename: img.storagePath.split("/").pop(),
      categoryHint: img.category,
    });
    ids.set(img.storagePath, image.id);
  }
  return ids;
}
