export type MatchingErrorCode =
  "invalid_input" | "image_not_found" | "article_not_found" | "missing_prerequisite" | "incompatible_embedding_model";

/** Permanent domain errors: retrying cannot fix missing data or a model mismatch. */
export class MatchingError extends Error {
  readonly retryable = false;
  constructor(
    readonly code: MatchingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class GuardInputError extends MatchingError {
  constructor(message: string) {
    super("invalid_input", message);
  }
}
export class ImageNotFoundError extends MatchingError {
  constructor(imageId: string) {
    super("image_not_found", `image ${imageId} not found`);
  }
}
export class ArticleNotFoundError extends MatchingError {
  constructor(articleId: string) {
    super("article_not_found", `article ${articleId} not found`);
  }
}
export class MissingPrerequisiteError extends MatchingError {
  constructor(
    readonly what: "classification" | "image embedding" | "article embeddings",
    detail: string,
  ) {
    super("missing_prerequisite", `${what} missing: ${detail}`);
  }
}
/** Vectors from different embedding models (or task types) live in different spaces and must never be compared. */
export class IncompatibleEmbeddingModelError extends MatchingError {
  constructor(
    readonly requested: string,
    readonly available: string[],
    subject: string,
  ) {
    super(
      "incompatible_embedding_model",
      `${subject} has no embedding in space "${requested}" (available: ${available.join(", ") || "none"}); refusing to compare across models or task types`,
    );
  }
}
