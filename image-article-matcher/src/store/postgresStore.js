import { NotFoundError } from "../ai/errors.js";
import { toPgVector } from "./vectorMath.js";
import { summarizeCalls } from "../services/costTracker.js";

/**
 * PostgreSQL + pgvector implementation of the Store interface.
 *
 * NOT VERIFIED against a real database anywhere in this project's build
 * environment (Docker Hub and therefore PostgreSQL/pgvector were
 * unreachable). It is written carefully, every query is parameterised,
 * and test/store.contract.test.js is written to run the SAME contract
 * against it when TEST_DATABASE_URL points at a real pgvector-enabled
 * database — see README "Verifying against real PostgreSQL".
 *
 * Note on JSONB: node-pg serialises JS arrays as PostgreSQL array
 * literals, not JSON, so every JSONB parameter is JSON.stringify'd.
 */

const mapImage = (r) => ({ id: r.id, storagePath: r.storage_path, originalFilename: r.original_filename, categoryHint: r.category_hint, status: r.status, createdAt: r.created_at });
const mapArticle = (r) => ({ id: r.id, title: r.title, body: r.body, category: r.category, tags: r.tags, status: r.status, createdAt: r.created_at });
const mapClassification = (r) => ({ id: r.id, imageId: r.image_id, category: r.category, tags: r.tags, confidence: r.confidence, rawModelOutput: r.raw_model_output, modelCallId: r.model_call_id, createdAt: r.created_at });
const mapJob = (r) => ({ id: r.id, type: r.type, payload: r.payload, status: r.status, attempts: r.attempts, lastError: r.last_error, runAfter: r.run_after, createdAt: r.created_at, updatedAt: r.updated_at });
const mapReview = (r) => ({ id: r.id, suggestionId: r.suggestion_id, reviewer: r.reviewer, decision: r.decision, notes: r.notes, createdAt: r.created_at });

export class PostgresStore {
  constructor(pool) {
    this.pool = pool;
  }

  async ping() {
    await this.pool.query("SELECT 1");
    return true;
  }

  async withTransaction(fn) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // --- images -------------------------------------------------------------
  async createImage({ storagePath, originalFilename = null, categoryHint = null }) {
    const inserted = await this.pool.query(
      `INSERT INTO images (storage_path, original_filename, category_hint) VALUES ($1, $2, $3)
       ON CONFLICT (storage_path) DO NOTHING RETURNING *`,
      [storagePath, originalFilename, categoryHint]
    );
    if (inserted.rows[0]) return { image: mapImage(inserted.rows[0]), created: true };
    const existing = await this.pool.query(`SELECT * FROM images WHERE storage_path = $1`, [storagePath]);
    return { image: mapImage(existing.rows[0]), created: false };
  }
  async getImage(id) {
    const { rows } = await this.pool.query(`SELECT * FROM images WHERE id = $1`, [id]);
    return rows[0] ? mapImage(rows[0]) : null;
  }
  async listImages() {
    const { rows } = await this.pool.query(`SELECT * FROM images ORDER BY id`);
    return rows.map(mapImage);
  }
  async setImageStatus(id, status) {
    const { rowCount } = await this.pool.query(`UPDATE images SET status = $2 WHERE id = $1`, [id, status]);
    if (rowCount === 0) throw new NotFoundError(`image ${id} not found`);
  }

  // --- articles -----------------------------------------------------------
  async createArticle({ title, body, category = null, tags = [] }) {
    const inserted = await this.pool.query(
      `INSERT INTO articles (title, body, category, tags) VALUES ($1, $2, $3, $4)
       ON CONFLICT (title) DO NOTHING RETURNING *`,
      [title, body, category, JSON.stringify(tags)]
    );
    if (inserted.rows[0]) return { article: mapArticle(inserted.rows[0]), created: true };
    const existing = await this.pool.query(`SELECT * FROM articles WHERE title = $1`, [title]);
    return { article: mapArticle(existing.rows[0]), created: false };
  }
  async getArticle(id) {
    const { rows } = await this.pool.query(`SELECT * FROM articles WHERE id = $1`, [id]);
    return rows[0] ? mapArticle(rows[0]) : null;
  }
  async listArticles() {
    const { rows } = await this.pool.query(`SELECT * FROM articles ORDER BY id`);
    return rows.map(mapArticle);
  }
  async setArticleStatus(id, status) {
    const { rowCount } = await this.pool.query(`UPDATE articles SET status = $2 WHERE id = $1`, [id, status]);
    if (rowCount === 0) throw new NotFoundError(`article ${id} not found`);
  }

  // --- model calls --------------------------------------------------------
  async recordModelCall(c) {
    const { rows } = await this.pool.query(
      `INSERT INTO model_calls
         (provider, model, operation, started_at, finished_at, input_tokens, output_tokens,
          tokens_estimated, estimated_cost_usd, cost_basis, success, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [c.provider, c.model, c.operation, c.startedAt, c.finishedAt ?? null, c.inputTokens ?? null, c.outputTokens ?? null,
        c.tokensEstimated === true, c.estimatedCostUsd ?? null, c.costBasis ?? "no_rate_configured", c.success, c.errorMessage ?? null]
    );
    return rows[0].id;
  }
  async listModelCalls() {
    const { rows } = await this.pool.query(`SELECT * FROM model_calls ORDER BY id`);
    return rows.map((r) => ({ id: r.id, provider: r.provider, model: r.model, operation: r.operation, startedAt: r.started_at, finishedAt: r.finished_at,
      inputTokens: r.input_tokens, outputTokens: r.output_tokens, tokensEstimated: r.tokens_estimated,
      estimatedCostUsd: r.estimated_cost_usd === null ? null : Number(r.estimated_cost_usd), costBasis: r.cost_basis, success: r.success, errorMessage: r.error_message }));
  }
  async summarizeModelCalls() {
    return summarizeCalls(await this.listModelCalls());
  }

  // --- classifications ----------------------------------------------------
  async insertClassification({ imageId, category, tags, confidence, rawModelOutput, modelCallId }) {
    const { rows } = await this.pool.query(
      `INSERT INTO classifications (image_id, category, tags, confidence, raw_model_output, model_call_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [imageId, category, JSON.stringify(tags), confidence, JSON.stringify(rawModelOutput), modelCallId]
    );
    return mapClassification(rows[0]);
  }
  async getLatestClassification(imageId) {
    const { rows } = await this.pool.query(`SELECT * FROM classifications WHERE image_id = $1 ORDER BY id DESC LIMIT 1`, [imageId]);
    return rows[0] ? mapClassification(rows[0]) : null;
  }

  // --- embeddings ---------------------------------------------------------
  async upsertEmbedding({ ownerType, ownerId, vector, model, modelCallId }) {
    await this.pool.query(
      `INSERT INTO embeddings (owner_type, owner_id, vector, model, model_call_id)
       VALUES ($1, $2, $3::vector, $4, $5)
       ON CONFLICT (owner_type, owner_id)
       DO UPDATE SET vector = EXCLUDED.vector, model = EXCLUDED.model, model_call_id = EXCLUDED.model_call_id, created_at = now()`,
      [ownerType, ownerId, toPgVector(vector), model, modelCallId]
    );
  }
  async hasEmbedding(ownerType, ownerId) {
    const { rowCount } = await this.pool.query(`SELECT 1 FROM embeddings WHERE owner_type = $1 AND owner_id = $2`, [ownerType, ownerId]);
    return rowCount > 0;
  }
  /** pgvector cosine distance (<=>); similarity = 1 - distance. */
  async findNearestArticles(imageId, k) {
    const { rows } = await this.pool.query(
      `SELECT a.id AS article_id, a.title, a.category, a.tags, 1 - (ae.vector <=> ie.vector) AS similarity
       FROM embeddings ie
       JOIN embeddings ae ON ae.owner_type = 'article'
       JOIN articles a ON a.id = ae.owner_id
       WHERE ie.owner_type = 'image' AND ie.owner_id = $1
       ORDER BY ae.vector <=> ie.vector ASC, a.id ASC
       LIMIT $2`,
      [imageId, k]
    );
    return rows.map((r) => ({ articleId: r.article_id, title: r.title, category: r.category, tags: r.tags, similarity: Number(r.similarity) }));
  }

  // --- suggestions --------------------------------------------------------
  async _hydrate(rows) {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const reasons = (await this.pool.query(`SELECT * FROM mismatch_reasons WHERE suggestion_id = ANY($1::int[]) ORDER BY id`, [ids])).rows;
    const reviews = (await this.pool.query(`SELECT * FROM reviews WHERE suggestion_id = ANY($1::int[]) ORDER BY id`, [ids])).rows;
    return rows.map((r) => {
      const myReviews = reviews.filter((v) => v.suggestion_id === r.id).map(mapReview);
      const latest = myReviews[myReviews.length - 1];
      return {
        id: r.id, imageId: r.image_id, articleId: r.article_id, similarityScore: r.similarity_score, rank: r.rank, decision: r.decision, createdAt: r.created_at,
        articleTitle: r.article_title ?? null,
        reasons: reasons.filter((x) => x.suggestion_id === r.id).map((x) => ({ reasonCode: x.reason_code, humanExplanation: x.human_explanation, signalValues: x.signal_values })),
        reviews: myReviews,
        reviewState: latest ? latest.decision : "unreviewed",
      };
    });
  }
  async hasSuggestions(imageId) {
    const { rowCount } = await this.pool.query(`SELECT 1 FROM matching_suggestions WHERE image_id = $1 LIMIT 1`, [imageId]);
    return rowCount > 0;
  }
  async replaceSuggestionsForImage(imageId, evaluated) {
    await this.withTransaction(async (client) => {
      await client.query(
        `DELETE FROM matching_suggestions s
         WHERE s.image_id = $1 AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.suggestion_id = s.id)`,
        [imageId]
      );
      const kept = new Set((await client.query(`SELECT article_id FROM matching_suggestions WHERE image_id = $1`, [imageId])).rows.map((r) => r.article_id));
      for (const ev of evaluated) {
        if (kept.has(ev.articleId)) continue;
        const inserted = await client.query(
          `INSERT INTO matching_suggestions (image_id, article_id, similarity_score, rank, decision)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [imageId, ev.articleId, ev.similarity, ev.rank, ev.decision]
        );
        for (const reason of ev.reasons) {
          await client.query(
            `INSERT INTO mismatch_reasons (suggestion_id, reason_code, human_explanation, signal_values) VALUES ($1, $2, $3, $4)`,
            [inserted.rows[0].id, reason.code, reason.explanation, JSON.stringify(reason.signals)]
          );
        }
      }
    });
  }
  async listSuggestionsForImage(imageId) {
    const { rows } = await this.pool.query(
      `SELECT s.*, a.title AS article_title FROM matching_suggestions s JOIN articles a ON a.id = s.article_id
       WHERE s.image_id = $1 ORDER BY s.rank ASC`,
      [imageId]
    );
    return this._hydrate(rows);
  }
  async getSuggestion(id) {
    const { rows } = await this.pool.query(
      `SELECT s.*, a.title AS article_title FROM matching_suggestions s JOIN articles a ON a.id = s.article_id WHERE s.id = $1`,
      [id]
    );
    return (await this._hydrate(rows))[0] ?? null;
  }
  async listSuggestions({ decision = null, reviewState = null, limit = 100 } = {}) {
    const where = [];
    const params = [];
    if (decision) {
      params.push(decision);
      where.push(`s.decision = $${params.length}`);
    }
    if (reviewState === "unreviewed") {
      where.push(`NOT EXISTS (SELECT 1 FROM reviews r WHERE r.suggestion_id = s.id)`);
    } else if (reviewState) {
      params.push(reviewState);
      where.push(`(SELECT r.decision FROM reviews r WHERE r.suggestion_id = s.id ORDER BY r.id DESC LIMIT 1) = $${params.length}`);
    }
    params.push(limit);
    const { rows } = await this.pool.query(
      `SELECT s.*, a.title AS article_title FROM matching_suggestions s JOIN articles a ON a.id = s.article_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY s.id ASC LIMIT $${params.length}`,
      params
    );
    return this._hydrate(rows);
  }

  // --- reviews ------------------------------------------------------------
  async createReview({ suggestionId, reviewer, decision, notes }) {
    const { rows } = await this.pool.query(
      `INSERT INTO reviews (suggestion_id, reviewer, decision, notes)
       SELECT $1, $2, $3, $4 WHERE EXISTS (SELECT 1 FROM matching_suggestions WHERE id = $1)
       RETURNING *`,
      [suggestionId, reviewer, decision, notes]
    );
    if (!rows[0]) throw new NotFoundError(`suggestion ${suggestionId} not found`);
    return mapReview(rows[0]);
  }

  // --- jobs ---------------------------------------------------------------
  async enqueueJob(type, payload, { runAfter = null } = {}) {
    const { rows } = await this.pool.query(
      `INSERT INTO jobs (type, payload, run_after) VALUES ($1, $2, COALESCE($3, now())) RETURNING id`,
      [type, JSON.stringify(payload), runAfter]
    );
    return rows[0].id;
  }
  /**
   * One atomic statement: pick the next eligible job (queued and due, or
   * "running" but stale past the visibility timeout) with FOR UPDATE SKIP
   * LOCKED, mark it running, and bump attempts. Two workers can never
   * claim the same row. NOT VERIFIED here — see class comment.
   */
  async claimNextJob({ now = new Date(), visibilityTimeoutMs = 300000 } = {}) {
    const staleBefore = new Date(now.getTime() - visibilityTimeoutMs);
    const { rows } = await this.pool.query(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = $1
       WHERE id = (
         SELECT id FROM jobs
         WHERE (status = 'queued' AND run_after <= $1) OR (status = 'running' AND updated_at <= $2)
         ORDER BY run_after ASC, id ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [now, staleBefore]
    );
    return rows[0] ? mapJob(rows[0]) : null;
  }
  async markJobDone(id) {
    await this.pool.query(`UPDATE jobs SET status = 'done', updated_at = now() WHERE id = $1`, [id]);
  }
  async markJobRetry(id, { error, runAfter }) {
    await this.pool.query(`UPDATE jobs SET status = 'queued', last_error = $2, run_after = $3, updated_at = now() WHERE id = $1`, [id, error, runAfter]);
  }
  async markJobFailed(id, error) {
    await this.pool.query(`UPDATE jobs SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1`, [id, error]);
  }
  async getJob(id) {
    const { rows } = await this.pool.query(`SELECT * FROM jobs WHERE id = $1`, [id]);
    return rows[0] ? mapJob(rows[0]) : null;
  }
  async listJobs({ status = null, limit = 100 } = {}) {
    const { rows } = status
      ? await this.pool.query(`SELECT * FROM jobs WHERE status = $1 ORDER BY id LIMIT $2`, [status, limit])
      : await this.pool.query(`SELECT * FROM jobs ORDER BY id LIMIT $1`, [limit]);
    return rows.map(mapJob);
  }
}
