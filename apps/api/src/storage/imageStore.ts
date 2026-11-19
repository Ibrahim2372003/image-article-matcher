import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, rename, stat, unlink, realpath, lstat } from "node:fs/promises";
import path from "node:path";
import { ImagePathSchema } from "@iam/shared";
import { ImageStorageError } from "./errors.js";
import { detectImageType, type DetectedImage } from "./magicBytes.js";

export interface StoredImage {
  sha256: string;
  mimeType: DetectedImage["mime"];
  byteSize: number;
  /** Relative to the storage root: `<sha256>.<ext>`. Satisfies `ImagePathSchema`. */
  storagePath: string;
}

/**
 * Content-addressed image storage. File names are derived ONLY from the SHA-256 of the bytes and the type detected
 * from those bytes, never from client input, so there is nothing for a client to traverse with. Writes go to a
 * private temp file first and are moved into place with an atomic rename. Keep the root out of Git.
 */
export class ImageStore {
  readonly root: string;
  private readonly tmpDir: string;

  constructor(
    root: string,
    readonly maxBytes: number,
  ) {
    this.root = path.resolve(root);
    this.tmpDir = path.join(this.root, ".tmp");
  }

  async save(bytes: Buffer): Promise<StoredImage> {
    if (bytes.length === 0) throw new ImageStorageError("unsupported_type", "the uploaded file is empty");
    if (bytes.length > this.maxBytes)
      throw new ImageStorageError("too_large", `image exceeds the ${this.maxBytes}-byte limit`);
    const type = detectImageType(bytes);
    if (!type) throw new ImageStorageError("unsupported_type", "only PNG, JPEG and WebP images are accepted");

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const storagePath = `${sha256}.${type.ext}`;
    const finalPath = path.join(this.root, storagePath);
    await mkdir(this.tmpDir, { recursive: true, mode: 0o700 });

    // Identical content already stored: nothing to write.
    const existing = await stat(finalPath).catch(() => null);
    if (existing?.isFile() && existing.size === bytes.length) {
      return { sha256, mimeType: type.mime, byteSize: bytes.length, storagePath };
    }

    const tmpPath = path.join(this.tmpDir, `${randomBytes(16).toString("hex")}.part`);
    try {
      const fh = await open(tmpPath, "wx", 0o600); // 'wx': never follow or overwrite an existing path
      try {
        await fh.writeFile(bytes);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmpPath, finalPath); // atomic replace within the same filesystem
    } finally {
      await unlink(tmpPath).catch(() => undefined); // gone after a successful rename; cleans up after any failure
    }
    return { sha256, mimeType: type.mime, byteSize: bytes.length, storagePath };
  }

  /** Resolves a stored relative path to an absolute one, refusing anything that could leave the root. */
  resolve(storagePath: string): string {
    if (!ImagePathSchema.safeParse(storagePath).success || storagePath.startsWith(".") || storagePath.includes("/")) {
      throw new ImageStorageError("invalid_path", "invalid image storage path");
    }
    const abs = path.resolve(this.root, storagePath);
    if (path.dirname(abs) !== this.root) throw new ImageStorageError("invalid_path", "invalid image storage path");
    return abs;
  }

  /** Reads a stored image, re-checking size, symlinks and the real file type from its bytes. */
  async read(storagePath: string): Promise<{ bytes: Buffer; type: DetectedImage }> {
    const abs = this.resolve(storagePath);
    const st = await lstat(abs).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") throw new ImageStorageError("not_found", "image file not found");
      throw e;
    });
    if (st.isSymbolicLink() || !st.isFile())
      throw new ImageStorageError("invalid_path", "image path is not a regular file");
    const real = await realpath(abs);
    if (path.dirname(real) !== (await realpath(this.root)))
      throw new ImageStorageError("invalid_path", "image path escapes the storage root");
    if (st.size > this.maxBytes)
      throw new ImageStorageError("too_large", `image exceeds the ${this.maxBytes}-byte limit`);
    const fh = await open(abs, "r");
    let bytes: Buffer;
    try {
      bytes = await fh.readFile();
    } finally {
      await fh.close();
    }
    const type = detectImageType(bytes);
    if (!type) throw new ImageStorageError("unsupported_type", "stored file is not a supported image");
    return { bytes, type };
  }
}
