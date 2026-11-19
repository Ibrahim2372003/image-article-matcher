import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImagePathSchema } from "@iam/shared";
import { ImageStorageError } from "../../src/storage/errors.js";
import { ImageStore } from "../../src/storage/imageStore.js";
import { createLoadImage } from "../../src/storage/loadImage.js";
import { GIF, HTML, JPEG, PNG, WEBP } from "./fixtures.js";

let dir = "";
let store: ImageStore;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "iam-img-"));
  store = new ImageStore(path.join(dir, "images"), 10_000);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const code = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as ImageStorageError).code;
const tmpLeftovers = async () => (await readdir(path.join(store.root, ".tmp")).catch(() => [])).length;

describe("ImageStore.save", () => {
  it("stores content-addressed files named from the BYTES (sha256 + detected extension)", async () => {
    for (const [buf, ext, mime] of [
      [PNG, "png", "image/png"],
      [JPEG, "jpg", "image/jpeg"],
      [WEBP, "webp", "image/webp"],
    ] as const) {
      const r = await store.save(buf);
      expect(r).toMatchObject({
        mimeType: mime,
        byteSize: buf.length,
        storagePath: `${createHash("sha256").update(buf).digest("hex")}.${ext}`,
      });
      expect(ImagePathSchema.safeParse(r.storagePath).success).toBe(true);
      expect(await readFile(path.join(store.root, r.storagePath))).toEqual(buf);
    }
  });
  it("is idempotent: identical bytes give one file and the same path", async () => {
    const a = await store.save(PNG);
    const b = await store.save(Buffer.from(PNG));
    expect(b.storagePath).toBe(a.storagePath);
    expect((await readdir(store.root)).filter((n) => !n.startsWith("."))).toHaveLength(1);
  });
  it("20 concurrent saves of the same bytes leave exactly one intact file and no temp files", async () => {
    const out = await Promise.all(Array.from({ length: 20 }, () => store.save(PNG)));
    expect(new Set(out.map((o) => o.storagePath)).size).toBe(1);
    expect(await readFile(path.join(store.root, out[0]!.storagePath))).toEqual(PNG);
    expect(await tmpLeftovers()).toBe(0);
  });
  it.each([
    ["empty", Buffer.alloc(0), "unsupported_type"],
    ["GIF", GIF, "unsupported_type"],
    ["HTML", HTML, "unsupported_type"],
  ])("rejects %s and writes nothing", async (_n, buf, expected) => {
    expect(await code(store.save(buf))).toBe(expected);
    expect((await readdir(store.root).catch(() => [])).filter((n) => !n.startsWith("."))).toEqual([]);
  });
  it("rejects oversized files BEFORE touching the disk", async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(20_000)]);
    expect(await code(store.save(big))).toBe("too_large");
    expect(await stat(store.root).catch(() => null)).toBeNull(); // not even the directory was created
  });
  it("leaves no temp file behind after a successful save, and files are not world-readable", async () => {
    const r = await store.save(PNG);
    expect(await tmpLeftovers()).toBe(0);
    if (process.platform !== "win32") expect((await stat(path.join(store.root, r.storagePath))).mode & 0o077).toBe(0);
  });
  it("cleans its temp file up when the move into place fails", async () => {
    await store.save(PNG); // creates dirs
    const r = await store.save(JPEG);
    // make the destination a directory so the atomic rename must fail
    await rm(path.join(store.root, r.storagePath));
    await mkdir(path.join(store.root, r.storagePath));
    await expect(store.save(JPEG)).rejects.toBeDefined();
    expect(await tmpLeftovers()).toBe(0);
  });
});

describe("path safety", () => {
  it.each([
    "../evil.png",
    "a/../../evil.png",
    "/etc/passwd.png",
    "C:/x.png",
    "a\\b.png",
    "sub/dir.png",
    ".tmp/x.png",
    ".hidden.png",
    "x.gif",
    "x\0.png",
    "",
  ])("resolve() rejects %j", (p) => {
    expect(() => store.resolve(p)).toThrow(ImageStorageError);
  });
  it("resolve() accepts only a flat file name inside the root", () => {
    const abs = store.resolve(`${"a".repeat(64)}.png`);
    expect(path.dirname(abs)).toBe(store.root);
  });
});

describe("loadImage / read", () => {
  it("returns base64 and takes the MIME from the BYTES, not the extension", async () => {
    const r = await store.save(JPEG);
    const load = createLoadImage(store);
    const out = await load(r.storagePath);
    expect(out.mimeType).toBe("image/jpeg");
    expect(Buffer.from(out.base64, "base64")).toEqual(JPEG);
  });
  it("a file whose extension lies about its content is judged by content", async () => {
    await store.save(PNG); // create root
    await writeFile(path.join(store.root, "lying.png"), JPEG);
    expect((await createLoadImage(store)("lying.png")).mimeType).toBe("image/jpeg");
    await writeFile(path.join(store.root, "text.png"), "not an image at all");
    expect(await code(createLoadImage(store)("text.png"))).toBe("unsupported_type");
  });
  it("reports a missing file as not_found (a permanent condition)", async () => {
    await store.save(PNG);
    expect(await code(createLoadImage(store)(`${"b".repeat(64)}.png`))).toBe("not_found");
  });
  it("refuses files larger than the limit even if they were placed there out of band", async () => {
    await store.save(PNG);
    await writeFile(path.join(store.root, "big.png"), Buffer.concat([PNG, Buffer.alloc(20_000)]));
    expect(await code(createLoadImage(store)("big.png"))).toBe("too_large");
  });
  it.skipIf(process.platform === "win32")("refuses a symlink that points outside the root", async () => {
    await store.save(PNG);
    const secret = path.join(dir, "secret.png");
    await writeFile(secret, PNG);
    await symlink(secret, path.join(store.root, "link.png"));
    expect(await code(createLoadImage(store)("link.png"))).toBe("invalid_path");
  });
  it("refuses traversal through the loader too", async () => {
    await store.save(PNG);
    expect(await code(createLoadImage(store)("../secret.png"))).toBe("invalid_path");
  });
});
