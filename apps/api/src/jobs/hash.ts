import { createHash } from "node:crypto";
import type { ArticleInput } from "@iam/shared";
import { normalizeLabel, normalizeLabels } from "../matching/guard.js";
import { InvalidIdempotencyKeyError } from "./errors.js";

export interface CanonicalArticle {
  title: string;
  body: string;
  category: string | null;
  tags: string[];
  contentHash: string;
}

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** Canonical form: trimmed title/body, normalised category, normalised + sorted + de-duplicated tags. */
export function canonicalizeArticle(input: ArticleInput): CanonicalArticle {
  const title = input.title.trim();
  const body = input.body.trim();
  const category = normalizeLabel(input.category) || null;
  const tags = [...normalizeLabels(input.tags)].sort();
  // JSON array (fixed order) so no field can bleed into another.
  return { title, body, category, tags, contentHash: sha256(JSON.stringify([title, body, category, tags])) };
}

export const requestFingerprint = (articleHash: string, imageSha256: string): string =>
  sha256(`${articleHash}:${imageSha256}`);

/** Default key: identical (article, image) submissions are the same job. */
export const derivedKey = (articleHash: string, imageSha256: string): string => `submit:${articleHash}:${imageSha256}`;

const CLIENT_KEY_RE = /^[A-Za-z0-9._~-]{1,128}$/;
/** Client keys live in their own namespace so they can never collide with derived (`submit:`) or `suggest:` keys. */
export function clientKey(raw: string): string {
  if (!CLIENT_KEY_RE.test(raw)) throw new InvalidIdempotencyKeyError();
  return `client:${raw}`;
}
