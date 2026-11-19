import type { LoadImage } from "../matching/prepare.js";
import type { ImageStore } from "./imageStore.js";

/** Adapts the store to the `LoadImage` hook used by the matching preparation steps. MIME comes from the BYTES. */
export function createLoadImage(store: ImageStore): LoadImage {
  return async (storagePath) => {
    const { bytes, type } = await store.read(storagePath);
    return { base64: bytes.toString("base64"), mimeType: type.mime };
  };
}
