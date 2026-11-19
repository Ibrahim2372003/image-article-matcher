import { describe, expect, it } from "vitest";
import { detectImageType } from "../../src/storage/magicBytes.js";
import { EXE, GIF, HTML, JPEG, PNG, SVG, WEBP, ZIP } from "./fixtures.js";

describe("detectImageType (never trusts name or client MIME)", () => {
  it("recognises PNG, JPEG and WebP from their own bytes", () => {
    expect(detectImageType(PNG)).toEqual({ mime: "image/png", ext: "png" });
    expect(detectImageType(JPEG)).toEqual({ mime: "image/jpeg", ext: "jpg" });
    expect(detectImageType(WEBP)).toEqual({ mime: "image/webp", ext: "webp" });
  });
  it.each([
    ["GIF", GIF],
    ["HTML", HTML],
    ["SVG (script-capable)", SVG],
    ["executable", EXE],
    ["zip", ZIP],
    ["empty", Buffer.alloc(0)],
    ["one byte", Buffer.from([0xff])],
    ["PNG signature but no IHDR", Buffer.concat([PNG.subarray(0, 12), Buffer.from("XXXX"), Buffer.alloc(20)])],
    ["truncated PNG signature", PNG.subarray(0, 6)],
    ["JPEG SOI without a marker", Buffer.from([0xff, 0xd8, 0xff, 0x00, 1, 2, 3])],
    [
      "RIFF that is not WebP (WAV)",
      Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 0, 0, 0]), Buffer.from("WAVEfmt "), Buffer.alloc(20)]),
    ],
    [
      "WebP header with an unknown chunk",
      Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 0, 0, 0]), Buffer.from("WEBPXXXX"), Buffer.alloc(20)]),
    ],
  ])("rejects %s", (_n, buf) => {
    expect(detectImageType(buf)).toBeNull();
  });
  it("is decided purely by content: image bytes are accepted whatever they would be 'named'", () => {
    expect(detectImageType(Buffer.from(JPEG))?.mime).toBe("image/jpeg");
  });
});
