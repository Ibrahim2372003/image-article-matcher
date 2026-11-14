import { evaluateMatch, type GuardConfig, type GuardResult } from "./guard.js";

export interface Candidate {
  articleId: string;
  similarity: number;
  category: string | null;
  tags: string[];
}

export interface EvaluatedCandidate {
  candidate: Candidate;
  rank: number;
  nextSimilarity: number | null;
  margin: number | null;
  result: GuardResult;
}

/** Cosine similarity of two equal-length vectors. Returns NaN for zero vectors; throws on length mismatch. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new RangeError(`vector length mismatch: ${a.length} vs ${b.length}`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Best first. NaN scores sort last; ties break on articleId so the order is fully deterministic. */
export function rankCandidates(candidates: readonly Candidate[]): Candidate[] {
  const key = (c: Candidate): number => (Number.isNaN(c.similarity) ? Number.NEGATIVE_INFINITY : c.similarity);
  return [...candidates].sort(
    (a, b) => key(b) - key(a) || (a.articleId < b.articleId ? -1 : a.articleId > b.articleId ? 1 : 0),
  );
}

/** Gap to the next candidate, or null for the last one. */
export function marginAt(sorted: readonly Candidate[], index: number): number | null {
  const cur = sorted[index];
  const nxt = sorted[index + 1];
  return cur && nxt ? cur.similarity - nxt.similarity : null;
}

/** Ranks the candidates and runs EVERY one through the guard (accepted and rejected alike). */
export function evaluateCandidates(
  classification: { category: string; tags: string[]; confidence: number },
  candidates: readonly Candidate[],
  config: GuardConfig,
  topK: number,
): EvaluatedCandidate[] {
  const sorted = rankCandidates(candidates).slice(0, topK);
  return sorted.map((candidate, i) => {
    const next = sorted[i + 1]?.similarity ?? null;
    const rank = i + 1;
    const result = evaluateMatch(
      {
        classification,
        article: { category: candidate.category, tags: candidate.tags },
        similarity: candidate.similarity,
        rank,
        nextSimilarity: next,
      },
      config,
    );
    return { candidate, rank, nextSimilarity: next, margin: marginAt(sorted, i), result };
  });
}
