import type { Pool, PoolClient } from "pg";
import { EmbeddingVectorSchema } from "@iam/shared";
import { MatchingError } from "./errors.js";
import type { Candidate } from "./ranking.js";
import {
  suggestionKey,
  suggestionKeyPrefix,
  toStorableSimilarity,
  type ArticleRow,
  type EmbeddingSpace,
  type EvaluationRecord,
  type ImageRow,
  type MatchStore,
  type SaveOutcome,
  type SavedEvaluation,
  type StoredClassification,
  type StoredEvaluation,
} from "./types.js";

type Db = Pick<Pool, "query" | "connect">;
interface SpaceRow {
  embedding_model: string;
  task_type: string;
}
const toSpace = (r: SpaceRow): EmbeddingSpace => ({ model: r.embedding_model, taskType: r.task_type });

/** pgvector text literal. Validates 768 finite numbers first, so nothing malformed reaches the database. */
export function toVectorLiteral(vector: unknown): string {
  const parsed = EmbeddingVectorSchema.safeParse(vector);
  if (!parsed.success) throw new MatchingError("invalid_input", "vector must be exactly 768 finite numbers");
  return `[${parsed.data.join(",")}]`;
}

export class PgMatchStore implements MatchStore {
  constructor(private readonly db: Db) {}

  async getImage(imageId: string): Promise<ImageRow | null> {
    const { rows } = await this.db.query<{ id: string; storage_path: string }>(
      "SELECT id, storage_path FROM images WHERE id = $1",
      [imageId],
    );
    return rows[0] ? { id: rows[0].id, storagePath: rows[0].storage_path } : null;
  }

  async getArticle(articleId: string): Promise<ArticleRow | null> {
    const { rows } = await this.db.query<ArticleRow>(
      "SELECT id, title, body, category, tags FROM articles WHERE id = $1",
      [articleId],
    );
    return rows[0] ?? null;
  }

  async getLatestClassification(imageId: string): Promise<StoredClassification | null> {
    const { rows } = await this.db.query<StoredClassification>(
      `SELECT category, tags, confidence, provider, model FROM image_classifications
       WHERE image_id = $1 ORDER BY created_at DESC, id LIMIT 1`,
      [imageId],
    );
    return rows[0] ?? null;
  }

  async upsertClassification(imageId: string, c: StoredClassification, rawOutput: unknown): Promise<void> {
    await this.db.query(
      `INSERT INTO image_classifications (image_id, category, tags, confidence, provider, model, raw_output)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (image_id, provider, model)
       DO UPDATE SET category = EXCLUDED.category, tags = EXCLUDED.tags, confidence = EXCLUDED.confidence,
                     raw_output = EXCLUDED.raw_output, created_at = now()`,
      [imageId, c.category, c.tags, c.confidence, c.provider, c.model, JSON.stringify(rawOutput)],
    );
  }

  async listImageEmbeddingSpaces(imageId: string): Promise<EmbeddingSpace[]> {
    const { rows } = await this.db.query<SpaceRow>(
      "SELECT DISTINCT embedding_model, task_type FROM image_embeddings WHERE image_id = $1 ORDER BY 1, 2",
      [imageId],
    );
    return rows.map(toSpace);
  }

  async listArticleEmbeddingSpaces(): Promise<EmbeddingSpace[]> {
    const { rows } = await this.db.query<SpaceRow>(
      "SELECT DISTINCT embedding_model, task_type FROM article_embeddings ORDER BY 1, 2",
    );
    return rows.map(toSpace);
  }

  async hasImageEmbedding(imageId: string, s: EmbeddingSpace): Promise<boolean> {
    const r = await this.db.query(
      "SELECT 1 FROM image_embeddings WHERE image_id = $1 AND embedding_model = $2 AND task_type = $3",
      [imageId, s.model, s.taskType],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async hasArticleEmbedding(articleId: string, s: EmbeddingSpace): Promise<boolean> {
    const r = await this.db.query(
      "SELECT 1 FROM article_embeddings WHERE article_id = $1 AND embedding_model = $2 AND task_type = $3",
      [articleId, s.model, s.taskType],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async upsertImageEmbedding(imageId: string, vector: number[], s: EmbeddingSpace): Promise<void> {
    await this.db.query(
      `INSERT INTO image_embeddings (image_id, embedding, embedding_model, task_type) VALUES ($1, $2::vector, $3, $4)
       ON CONFLICT (image_id, embedding_model) DO UPDATE SET embedding = EXCLUDED.embedding, task_type = EXCLUDED.task_type, created_at = now()`,
      [imageId, toVectorLiteral(vector), s.model, s.taskType],
    );
  }

  async upsertArticleEmbedding(articleId: string, vector: number[], s: EmbeddingSpace): Promise<void> {
    await this.db.query(
      `INSERT INTO article_embeddings (article_id, embedding, embedding_model, task_type) VALUES ($1, $2::vector, $3, $4)
       ON CONFLICT (article_id, embedding_model) DO UPDATE SET embedding = EXCLUDED.embedding, task_type = EXCLUDED.task_type, created_at = now()`,
      [articleId, toVectorLiteral(vector), s.model, s.taskType],
    );
  }

  /** Cosine distance (`<=>`) ranking; similarity = 1 - distance. Only vectors in the SAME model + task type are compared. */
  async findNearestArticles(imageId: string, s: EmbeddingSpace, limit: number): Promise<Candidate[]> {
    const { rows } = await this.db.query<{
      article_id: string;
      category: string | null;
      tags: string[];
      similarity: number;
    }>(
      `WITH q AS (SELECT embedding FROM image_embeddings WHERE image_id = $1 AND embedding_model = $2 AND task_type = $3)
       SELECT a.id AS article_id, a.category, a.tags, 1 - (ae.embedding <=> q.embedding) AS similarity
       FROM article_embeddings ae
       JOIN articles a ON a.id = ae.article_id
       CROSS JOIN q
       WHERE ae.embedding_model = $2 AND ae.task_type = $3
       ORDER BY ae.embedding <=> q.embedding, a.id
       LIMIT $4`,
      [imageId, s.model, s.taskType, limit],
    );
    return rows.map((r) => ({
      articleId: r.article_id,
      category: r.category,
      tags: r.tags,
      similarity: Number(r.similarity),
    }));
  }

  async hasEvaluations(imageId: string): Promise<boolean> {
    const r = await this.db.query(
      "SELECT 1 FROM analysis_jobs WHERE image_id = $1 AND idempotency_key LIKE $2 LIMIT 1",
      [imageId, `${suggestionKeyPrefix(imageId)}%`],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * ONE transaction for the whole batch: either every evaluation is persisted or none is. Rows are processed in a
   * fixed (articleId) order so two concurrent runs cannot deadlock. Per row: insert, or re-evaluate an UNREVIEWED
   * row, or leave a reviewed row untouched. The row is locked (FOR UPDATE) FIRST and the review check runs as a
   * separate, later statement, so a review that commits while we wait for the lock is always seen.
   */
  async saveEvaluations(records: EvaluationRecord[]): Promise<SavedEvaluation[]> {
    const client: PoolClient = await this.db.connect();
    try {
      await client.query("BEGIN");
      const byArticle = new Map<string, SavedEvaluation>();
      for (const rec of [...records].sort((a, b) =>
        a.articleId < b.articleId ? -1 : a.articleId > b.articleId ? 1 : 0,
      )) {
        byArticle.set(rec.articleId, await this.saveOne(client, rec));
      }
      await client.query("COMMIT");
      return records.map((r) => byArticle.get(r.articleId) as SavedEvaluation);
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* connection already broken; the original error is what matters */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  private async saveOne(client: PoolClient, rec: EvaluationRecord): Promise<SavedEvaluation> {
    const key = suggestionKey(rec.imageId, rec.articleId);
    const status = rec.decision === "review" ? "needs_review" : "completed";
    const v = {
      provider: rec.classification.provider,
      model: rec.classification.model,
      prediction: JSON.stringify({
        category: rec.classification.category,
        tags: rec.classification.tags,
        confidence: rec.classification.confidence,
      }),
      similarity: toStorableSimilarity(rec.similarity),
      decision: rec.decision,
      reasons: JSON.stringify(rec.reasons),
      policyVersion: rec.policyVersion,
      policyConfig: JSON.stringify(rec.policyConfig),
      signals: JSON.stringify({
        ...rec.signals,
        rank: rec.rank,
        primaryReasonCode: rec.primaryReasonCode,
        embeddingTaskType: rec.space.taskType,
      }),
      embeddingModel: rec.space.model,
      status,
    };
    // Placeholders: $1 provider $2 model $3 prediction $4 similarity $5 decision $6 reasons $7 policy_version
    // $8 policy_config $9 signals $10 embedding_model $11 status | $12 article_id $13 image_id $14 key
    const ins = await client.query<{ id: string }>(
      `INSERT INTO analysis_jobs (article_id, image_id, idempotency_key, status, model_provider, model_name, model_prediction,
         similarity, decision, decision_reasons, policy_version, policy_config, guard_signals, embedding_model, completed_at)
       VALUES ($12, $13, $14, $11, $1, $2, $3::jsonb, $4, $5, $6::jsonb, $7, $8::jsonb, $9::jsonb, $10, now())
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [
        v.provider,
        v.model,
        v.prediction,
        v.similarity,
        v.decision,
        v.reasons,
        v.policyVersion,
        v.policyConfig,
        v.signals,
        v.embeddingModel,
        v.status,
        rec.articleId,
        rec.imageId,
        key,
      ],
    );

    let outcome: SaveOutcome;
    let jobId: string;
    let fromStatus: string | null = null;
    if (ins.rows[0]) {
      outcome = "created";
      jobId = ins.rows[0].id;
    } else {
      const locked = await client.query<{ id: string; status: string }>(
        "SELECT id, status FROM analysis_jobs WHERE idempotency_key = $1 FOR UPDATE",
        [key],
      );
      const row = locked.rows[0];
      if (!row) throw new MatchingError("invalid_input", "evaluation row vanished during save");
      jobId = row.id;
      // Separate statement, after the lock: sees any review that committed while we waited.
      const reviewed = await client.query("SELECT 1 FROM reviews WHERE job_id = $1", [jobId]);
      if ((reviewed.rowCount ?? 0) > 0) return { articleId: rec.articleId, jobId, outcome: "preserved" };
      fromStatus = row.status;
      await client.query(
        `UPDATE analysis_jobs SET model_provider = $1, model_name = $2, model_prediction = $3::jsonb, similarity = $4, decision = $5,
           decision_reasons = $6::jsonb, policy_version = $7, policy_config = $8::jsonb, guard_signals = $9::jsonb,
           embedding_model = $10, status = $11, completed_at = now()
         WHERE id = $12`,
        [
          v.provider,
          v.model,
          v.prediction,
          v.similarity,
          v.decision,
          v.reasons,
          v.policyVersion,
          v.policyConfig,
          v.signals,
          v.embeddingModel,
          v.status,
          jobId,
        ],
      );
      outcome = "updated";
    }
    await client.query(
      `INSERT INTO job_audit_events (job_id, event_type, actor, from_status, to_status, details)
       VALUES ($1, 'guard_evaluated', 'system:mismatch-guard', $2, $3, $4::jsonb)`,
      [
        jobId,
        fromStatus,
        status,
        JSON.stringify({
          outcome,
          decision: rec.decision,
          primaryReasonCode: rec.primaryReasonCode,
          policyVersion: rec.policyVersion,
          rank: rec.rank,
        }),
      ],
    );
    return { articleId: rec.articleId, jobId, outcome };
  }

  async listEvaluationsForImage(imageId: string): Promise<StoredEvaluation[]> {
    const { rows } = await this.db.query<{
      id: string;
      article_id: string;
      status: string;
      decision: StoredEvaluation["decision"];
      similarity: number | null;
      match_rank: string | null;
      decision_reasons: StoredEvaluation["reasons"];
      reviewed: boolean;
    }>(
      `SELECT j.id, j.article_id, j.status, j.decision, j.similarity, j.guard_signals->>'rank' AS match_rank, j.decision_reasons,
              EXISTS (SELECT 1 FROM reviews r WHERE r.job_id = j.id) AS reviewed
       FROM analysis_jobs j WHERE j.image_id = $1 AND j.idempotency_key LIKE $2
       ORDER BY (j.guard_signals->>'rank')::int NULLS LAST, j.article_id`,
      [imageId, `${suggestionKeyPrefix(imageId)}%`],
    );
    return rows.map((r) => ({
      jobId: r.id,
      articleId: r.article_id,
      status: r.status,
      decision: r.decision,
      similarity: r.similarity === null ? null : Number(r.similarity),
      rank: r.match_rank === null ? null : Number(r.match_rank),
      reasons: r.decision_reasons,
      hasReview: r.reviewed,
    }));
  }
}
