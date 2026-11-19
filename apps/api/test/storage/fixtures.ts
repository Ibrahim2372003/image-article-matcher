/** Minimal byte sequences that satisfy the signature checks (not decodable images; enough for sniffing/storage). */
const pad = (b: Buffer, n = 64): Buffer => Buffer.concat([b, Buffer.alloc(Math.max(0, n - b.length), 7)]);
export const PNG = pad(
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
    Buffer.from("IHDR", "latin1"),
  ]),
);
export const JPEG = pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0]));
export const WEBP = pad(
  Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.from([40, 0, 0, 0]), Buffer.from("WEBPVP8 ", "latin1")]),
);
export const GIF = pad(Buffer.from("GIF89a", "latin1"));
export const HTML = Buffer.from("<html><script>alert(1)</script></html>");
export const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
export const EXE = pad(Buffer.from("MZ", "latin1"));
export const ZIP = pad(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
