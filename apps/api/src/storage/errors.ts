export type ImageStorageErrorCode = "not_found" | "too_large" | "unsupported_type" | "invalid_path";

/** Permanent image problems: retrying the job cannot fix a missing/oversized/unsupported file. */
export class ImageStorageError extends Error {
  constructor(
    readonly code: ImageStorageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ImageStorageError";
  }
}
