import { describe, expect, it } from "vitest";
import { canonicalizeArticle, clientKey, derivedKey, requestFingerprint } from "../../src/jobs/hash.js";
import { InvalidIdempotencyKeyError } from "../../src/jobs/errors.js";

const art = (over: Partial<{ title: string; body: string; category: string; tags: string[] }> = {}) =>
  canonicalizeArticle({
    title: "River walk",
    body: "A walk by the river.",
    category: "Nature",
    tags: ["River", "walk"],
    ...over,
  });

describe("canonicalizeArticle", () => {
  it("is insensitive to whitespace, case of category/tags, tag order and duplicates", () => {
    const a = art();
    const b = art({
      title: "  River walk ",
      body: "A walk by the river.\n",
      category: " nature ",
      tags: ["WALK", "river", "walk"],
    });
    expect(b.contentHash).toBe(a.contentHash);
    expect(b.tags).toEqual(["river", "walk"]);
    expect(b.category).toBe("nature");
  });
  it("different title, body, category or tags give different hashes", () => {
    const h = art().contentHash;
    expect(art({ title: "River walks" }).contentHash).not.toBe(h);
    expect(art({ body: "Another body." }).contentHash).not.toBe(h);
    expect(art({ category: "travel" }).contentHash).not.toBe(h);
    expect(art({ tags: ["river"] }).contentHash).not.toBe(h);
  });
  it("fields cannot bleed into each other", () => {
    expect(art({ title: "ab", body: "c" }).contentHash).not.toBe(art({ title: "a", body: "bc" }).contentHash);
    expect(art({ category: "a", tags: ["b"] }).contentHash).not.toBe(art({ category: "ab", tags: [] }).contentHash);
  });
  it("a missing category is null, and is distinct from a real one", () => {
    const none = canonicalizeArticle({ title: "t", body: "b", tags: [] });
    expect(none.category).toBeNull();
    expect(none.contentHash).not.toBe(
      canonicalizeArticle({ title: "t", body: "b", category: "x", tags: [] }).contentHash,
    );
  });
});

describe("keys and fingerprints", () => {
  const a = "a".repeat(64);
  const i = "b".repeat(64);
  it("fingerprint depends on both article and image", () => {
    expect(requestFingerprint(a, i)).not.toBe(requestFingerprint(a, "c".repeat(64)));
    expect(requestFingerprint(a, i)).not.toBe(requestFingerprint("d".repeat(64), i));
    expect(requestFingerprint(a, i)).toBe(requestFingerprint(a, i));
  });
  it("derived keys are namespaced and fit the 200-char column limit", () => {
    expect(derivedKey(a, i)).toBe(`submit:${a}:${i}`);
    expect(derivedKey(a, i).length).toBeLessThanOrEqual(200);
  });
  it("client keys get their own namespace so they cannot collide with submit: or suggest: keys", () => {
    expect(clientKey("abc-123_X.y~z")).toBe("client:abc-123_X.y~z");
    expect(clientKey("suggest").startsWith("client:")).toBe(true);
  });
  it.each(["", " ", "a b", "a:b", "a/b", "é", "x".repeat(129), "a\nb", "k;DROP"])(
    "rejects invalid client key %j",
    (k) => {
      expect(() => clientKey(k)).toThrow(InvalidIdempotencyKeyError);
    },
  );
  it("accepts a 128-character key", () => {
    expect(clientKey("x".repeat(128))).toHaveLength(7 + 128);
  });
});
