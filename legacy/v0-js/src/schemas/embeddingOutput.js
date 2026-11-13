import { z } from "zod";
import { EMBEDDING_DIMENSION } from "../config.js";

/** An embedding must be exactly EMBEDDING_DIMENSION finite numbers — checked before it can reach a VECTOR(768) column. */
export const EmbeddingVectorSchema = z
  .array(z.number({ invalid_type_error: "embedding values must be numbers" }).finite("embedding values must be finite"))
  .length(EMBEDDING_DIMENSION, `embedding must have exactly ${EMBEDDING_DIMENSION} dimensions`);

export function formatEmbeddingError(zodError) {
  return zodError.issues.map((issue) => issue.message).join("; ");
}
