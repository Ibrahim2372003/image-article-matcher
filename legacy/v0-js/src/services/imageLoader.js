import path from "node:path";
import { readFile as fsReadFile } from "node:fs/promises";
import { PermanentError } from "../ai/errors.js";

const MIME_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export function mimeTypeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? null;
}

/**
 * Resolve a stored image path against the images root, refusing
 * anything that escapes it. storagePath reaches here from an API
 * request body, and the file at the resolved path is read and sent to a
 * third-party model — an unchecked path would be arbitrary file read.
 */
export function resolveImagePath(storagePath, root) {
  if (typeof storagePath !== "string" || storagePath.length === 0) {
    throw new PermanentError("storagePath must be a non-empty string");
  }
  if (storagePath.includes("\0")) throw new PermanentError("storagePath contains a null byte");
  if (path.isAbsolute(storagePath) || path.win32.isAbsolute(storagePath)) {
    throw new PermanentError("absolute image paths are not allowed");
  }
  const rootResolved = path.resolve(root);
  const full = path.resolve(rootResolved, storagePath);
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) {
    throw new PermanentError("image path escapes the images directory");
  }
  if (!mimeTypeFor(full)) throw new PermanentError(`unsupported image type: ${path.extname(full) || "(none)"}`);
  return full;
}

export async function loadImage(storagePath, { root, readFile = fsReadFile }) {
  const full = resolveImagePath(storagePath, root);
  let buffer;
  try {
    buffer = await readFile(full);
  } catch (err) {
    if (err?.code === "ENOENT") throw new PermanentError(`image file not found: ${storagePath}`);
    throw err;
  }
  if (buffer.length > MAX_IMAGE_BYTES) throw new PermanentError(`image exceeds ${MAX_IMAGE_BYTES} bytes`);
  return { base64: buffer.toString("base64"), mimeType: mimeTypeFor(full), bytes: buffer.length };
}
