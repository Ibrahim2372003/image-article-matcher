import { cosineSimilarity, rankCandidates } from "../../src/matching/ranking.js";
import {
  sameSpace,
  suggestionKey,
  type ArticleRow,
  type EmbeddingSpace,
  type EvaluationRecord,
  type ImageRow,
  type MatchStore,
  type SavedEvaluation,
  type StoredClassification,
  type StoredEvaluation,
} from "../../src/matching/types.js";
import type { Candidate } from "../../src/matching/ranking.js";

interface Row {
  jobId: string;
  rec: EvaluationRecord;
  reviewed: boolean;
}

/** In-memory MatchStore mirroring the real contract: same-space retrieval, atomic batch saves, review preservation. */
export class FakeStore implements MatchStore {
  images = new Map<string, ImageRow>();
  articles = new Map<string, ArticleRow>();
  classifications = new Map<string, StoredClassification[]>();
  imageVectors = new Map<string, Array<{ space: EmbeddingSpace; vector: number[] }>>();
  articleVectors = new Map<string, Array<{ space: EmbeddingSpace; vector: number[] }>>();
  rows = new Map<string, Row>();
  calls: string[] = [];
  /** Throw while saving the n-th record (0-based) to simulate a mid-batch failure. */
  failAtRecord: number | null = null;
  private seq = 0;

  addImage(id: string, storagePath = `${id}.png`): void {
    this.images.set(id, { id, storagePath });
  }
  addArticle(id: string, category: string | null = null, tags: string[] = []): void {
    this.articles.set(id, { id, title: `title ${id}`, body: `body ${id}`, category, tags });
  }
  review(imageId: string, articleId: string): void {
    const row = this.rows.get(suggestionKey(imageId, articleId));
    if (!row) throw new Error("no such evaluation");
    row.reviewed = true;
  }

  async getImage(id: string) {
    return this.images.get(id) ?? null;
  }
  async getArticle(id: string) {
    return this.articles.get(id) ?? null;
  }
  async getLatestClassification(imageId: string) {
    const list = this.classifications.get(imageId) ?? [];
    return list[list.length - 1] ?? null;
  }
  async upsertClassification(imageId: string, c: StoredClassification) {
    this.calls.push("upsertClassification");
    this.classifications.set(imageId, [
      ...(this.classifications.get(imageId) ?? []).filter((x) => !(x.provider === c.provider && x.model === c.model)),
      c,
    ]);
  }
  async listImageEmbeddingSpaces(imageId: string) {
    return (this.imageVectors.get(imageId) ?? []).map((e) => e.space);
  }
  async listArticleEmbeddingSpaces() {
    return [...this.articleVectors.values()].flat().map((e) => e.space);
  }
  async hasImageEmbedding(imageId: string, s: EmbeddingSpace) {
    return (this.imageVectors.get(imageId) ?? []).some((e) => sameSpace(e.space, s));
  }
  async hasArticleEmbedding(articleId: string, s: EmbeddingSpace) {
    return (this.articleVectors.get(articleId) ?? []).some((e) => sameSpace(e.space, s));
  }
  async upsertImageEmbedding(imageId: string, vector: number[], space: EmbeddingSpace) {
    this.calls.push("upsertImageEmbedding");
    this.imageVectors.set(imageId, [
      ...(this.imageVectors.get(imageId) ?? []).filter((e) => e.space.model !== space.model),
      { space, vector },
    ]);
  }
  async upsertArticleEmbedding(articleId: string, vector: number[], space: EmbeddingSpace) {
    this.calls.push("upsertArticleEmbedding");
    this.articleVectors.set(articleId, [
      ...(this.articleVectors.get(articleId) ?? []).filter((e) => e.space.model !== space.model),
      { space, vector },
    ]);
  }
  async findNearestArticles(imageId: string, space: EmbeddingSpace, limit: number): Promise<Candidate[]> {
    this.calls.push("findNearestArticles");
    const q = (this.imageVectors.get(imageId) ?? []).find((e) => sameSpace(e.space, space));
    if (!q) return [];
    const out: Candidate[] = [];
    for (const [articleId, vecs] of this.articleVectors) {
      const v = vecs.find((e) => sameSpace(e.space, space));
      const a = this.articles.get(articleId);
      if (v && a)
        out.push({ articleId, category: a.category, tags: a.tags, similarity: cosineSimilarity(q.vector, v.vector) });
    }
    return rankCandidates(out).slice(0, limit);
  }
  async hasEvaluations(imageId: string) {
    return [...this.rows.values()].some((r) => r.rec.imageId === imageId);
  }
  async saveEvaluations(records: EvaluationRecord[]): Promise<SavedEvaluation[]> {
    const staged = new Map(this.rows);
    const out: SavedEvaluation[] = [];
    records.forEach((rec, i) => {
      if (this.failAtRecord === i) throw new Error("simulated database failure");
      const key = suggestionKey(rec.imageId, rec.articleId);
      const existing = staged.get(key);
      if (!existing) {
        const jobId = `job-${(this.seq += 1)}`;
        staged.set(key, { jobId, rec, reviewed: false });
        out.push({ articleId: rec.articleId, jobId, outcome: "created" });
      } else if (existing.reviewed) {
        out.push({ articleId: rec.articleId, jobId: existing.jobId, outcome: "preserved" });
      } else {
        staged.set(key, { ...existing, rec });
        out.push({ articleId: rec.articleId, jobId: existing.jobId, outcome: "updated" });
      }
    });
    this.rows = staged; // commit: all or nothing
    return out;
  }
  async listEvaluationsForImage(imageId: string): Promise<StoredEvaluation[]> {
    return [...this.rows.values()]
      .filter((r) => r.rec.imageId === imageId)
      .sort((a, b) => a.rec.rank - b.rec.rank)
      .map((r) => ({
        jobId: r.jobId,
        articleId: r.rec.articleId,
        status: r.rec.decision === "review" ? "needs_review" : "completed",
        decision: r.rec.decision,
        similarity: r.rec.similarity,
        rank: r.rec.rank,
        reasons: r.rec.reasons,
        hasReview: r.reviewed,
      }));
  }
}

/** Unit vector pointing mostly along axis `axis` with a small tilt toward axis `tilt`. */
export function vec(axis: number, tilt = 0, tiltAmount = 0): number[] {
  const v = new Array<number>(768).fill(0);
  v[axis] = 1;
  if (tilt !== axis) v[tilt] = tiltAmount;
  return v;
}
