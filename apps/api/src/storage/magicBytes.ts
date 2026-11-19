export interface DetectedImage {
  mime: "image/png" | "image/jpeg" | "image/webp";
  ext: "png" | "jpg" | "webp";
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const startsWith = (buf: Buffer, bytes: number[], at = 0): boolean =>
  buf.length >= at + bytes.length && bytes.every((b, i) => buf[at + i] === b);
const ascii = (buf: Buffer, at: number, s: string): boolean =>
  buf.length >= at + s.length && buf.toString("latin1", at, at + s.length) === s;

/**
 * Identifies PNG, JPEG and WebP from the file's own leading bytes. The client's MIME type and file name are never
 * consulted. This is a signature check, not a decode: it blocks mislabelled files (HTML, SVG, scripts, archives,
 * GIFs) but a deliberately crafted polyglot that starts with a valid image header can still pass; the bytes are
 * only ever stored and sent to the AI provider, never executed or served back with a content type of its choosing.
 */
export function detectImageType(buf: Buffer): DetectedImage | null {
  // PNG: 8-byte signature, then the first chunk must be IHDR.
  if (startsWith(buf, PNG_SIG) && ascii(buf, 12, "IHDR")) return { mime: "image/png", ext: "png" };
  // JPEG: SOI (FF D8) followed by a marker (FF xx, xx >= C0).
  if (startsWith(buf, [0xff, 0xd8, 0xff]) && buf.length >= 4 && (buf[3] as number) >= 0xc0)
    return { mime: "image/jpeg", ext: "jpg" };
  // WebP: RIFF <size> WEBP then a VP8 / VP8L / VP8X chunk.
  if (
    ascii(buf, 0, "RIFF") &&
    ascii(buf, 8, "WEBP") &&
    (ascii(buf, 12, "VP8 ") || ascii(buf, 12, "VP8L") || ascii(buf, 12, "VP8X"))
  ) {
    return { mime: "image/webp", ext: "webp" };
  }
  return null;
}
