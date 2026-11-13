import { NotFoundError } from "../ai/errors.js";
import { EMBEDDING_DIMENSION } from "../config.js";
import { cosineSimilarity } from "./vectorMath.js";
import { summarizeCalls } from "../services/costTracker.js";

const clone = (value) => structuredClone(value);

/**
 * In-memory implementation of the Store interface. It is NOT a
 * substitute database for the product — production runs on PostgreSQL
 * (see postgresStore.js). It exists so the services, job worker, API
 * routes, and offline evaluation can be exercised against real,
 * stateful behaviour (foreign keys, uniqueness, dimension checks,
 * atomic job claiming) without a database server. The same contract
 * test suite runs against both implementations; only this one can run
 * in an environment with no PostgreSQL.
 */
export class MemoryStore {
  constructor({ clock = () => new Date() } = {}) {
    this.clock = clock;
    this.reset();
  }

  reset() {
    this.images = [];
    this.articles = [];
    this.modelCalls = [];
    this.classifications = [];
    this.embeddings = new Map();
    this.suggestions = [];
    this.reasons = [];
    this.reviews = [];
    this.jobs = [];
    this.seq = { image: 0, article: 0, call: 0, classification: 0, suggestion: 0, reason: 0, review: 0, job: 0 };
  }

  _id(kind) {
    this.seq[kind] += 1;
    return this.seq[kind];
  }

  async ping() {
    return true;
  }

  // --- images -------------------------------------------------------------
  async createImage({ storagePath, originalFilename = null, categoryHint = null }) {
    const existing = this.images.find((i) => i.storagePath === storagePath);
    if (existing) return { image: clone(existing), created: false };
    const image = { id: this._id("image"), storagePath, originalFilename, categoryHint, status: "pending", createdAt: this.clock() };
    this.images.push(image);
    return { image: clone(image), created: true };
  }
  async getImage(id) {
    const image = this.images.find((i) => i.id === id);
    return image ? clone(image) : null;
  }
  async listImages() {
    return this.images.map(clone);
  }
  async setImageStatus(id, status) {
    const image = this.images.find((i) => i.id === id);
    if (!image) throw new NotFoundError(`image ${id} not found`);
    image.status = status;
  }

  // --- articles -----------------------------------------------------------
  async createArticle({ title, body, category = null, tags = [] }) {
    const existing = this.articles.find((a) => a.title === title);
    if (existing) return { article: clone(existing), created: false };
    const article = { id: this._id("article"), title, body, category, tags: clone(tags), status: "pending", createdAt: this.clock() };
    this.articles.push(article);
    return { article: clone(article), created: true };
  }
  async getArticle(id) {
    const article = this.articles.find((a) => a.id === id);
    return article ? clone(article) : null;
  }
  async listArticles() {
    return this.articles.map(clone);
  }
  async setArticleStatus(id, status) {
    const article = this.articles.find((a) => a.id === id);
    if (!article) throw new NotFoundError(`article ${id} not found`);
    article.status = status;
  }

  // --- model calls --------------------------------------------------------
  async recordModelCall(call) {
    const row = {
      id: this._id("call"),
      provider: call.provider,
      model: call.model,
      operation: call.operation,
      startedAt: call.startedAt,
      finishedAt: call.finishedAt ?? null,
      inputTokens: call.inputTokens ?? null,
      outputTokens: call.outputTokens ?? null,
      tokensEstimated: call.tokensEstimated === true,
      estimatedCostUsd: call.estimatedCostUsd ?? null,
      costBasis: call.costBasis ?? "no_rate_configured",
      success: call.success,
      errorMessage: call.errorMessage ?? null,
    };
    this.modelCalls.push(row);
    return row.id;
  }
  async listModelCalls() {
    return this.modelCalls.map(clone);
  }
  async summarizeModelCalls() {
    return summarizeCalls(this.modelCalls);
  }

  // --- classifications ----------------------------------------------------
  async insertClassification({ imageId, category, tags, confidence, rawModelOutput, modelCallId }) {
    if (!this.images.some((i) => i.id === imageId)) throw new Error("foreign key violation: classifications.image_id");
    if (!this.modelCalls.some((c) => c.id === modelCallId)) throw new Error("foreign key violation: classifications.model_call_id");
    if (!(confidence >= 0 && confidence <= 1)) throw new Error("check violation: classifications.confidence");
    const row = { id: this._id("classification"), imageId, category, tags: clone(tags), confidence, rawModelOutput: clone(rawModelOutput), modelCallId, createdAt: this.clock() };
    this.classifications.push(row);
    return clone(row);
  }
  async getLatestClassification(imageId) {
    const rows = this.classifications.filter((c) => c.imageId === imageId);
    return rows.length ? clone(rows[rows.length - 1]) : null;
  }

  // --- embeddings ---------------------------------------------------------
  async upsertEmbedding({ ownerType, ownerId, vector, model, modelCallId }) {
    if (vector.length !== EMBEDDING_DIMENSION) throw new Error(`expected ${EMBEDDING_DIMENSION} dimensions, not ${vector.length}`);
    if (!this.modelCalls.some((c) => c.id === modelCallId)) throw new Error("foreign key violation: embeddings.model_call_id");
    this.embeddings.set(`${ownerType}:${ownerId}`, { ownerType, ownerId, vector: [...vector], model, modelCallId });
  }
  async hasEmbedding(ownerType, ownerId) {
    return this.embeddings.has(`${ownerType}:${ownerId}`);
  }
  async findNearestArticles(imageId, k) {
    const image = this.embeddings.get(`image:${imageId}`);
    if (!image) return [];
    const rows = [];
    for (const embedding of this.embeddings.values()) {
      if (embedding.ownerType !== "article") continue;
      const article = this.articles.find((a) => a.id === embedding.ownerId);
      if (!article) continue;
      rows.push({
        articleId: article.id,
        title: article.title,
        category: article.category,
        tags: clone(article.tags),
        similarity: cosineSimilarity(image.vector, embedding.vector),
      });
    }
    rows.sort((a, b) => b.similarity - a.similarity || a.articleId - b.articleId);
    return rows.slice(0, k);
  }

  // --- suggestions --------------------------------------------------------
  _hydrate(suggestion) {
    const article = this.articles.find((a) => a.id === suggestion.articleId);
    const reasons = this.reasons
      .filter((r) => r.suggestionId === suggestion.id)
      .map((r) => ({ reasonCode: r.reasonCode, humanExplanation: r.humanExplanation, signalValues: clone(r.signalValues) }));
    const reviews = this.reviews.filter((r) => r.suggestionId === suggestion.id).map(clone);
    const latest = reviews[reviews.length - 1];
    return { ...clone(suggestion), articleTitle: article?.title ?? null, reasons, reviews, reviewState: latest ? latest.decision : "unreviewed" };
  }
  async hasSuggestions(imageId) {
    return this.suggestions.some((s) => s.imageId === imageId);
  }
  async replaceSuggestionsForImage(imageId, evaluated) {
    if (!this.images.some((i) => i.id === imageId)) throw new Error("foreign key violation: matching_suggestions.image_id");
    const reviewed = new Set(this.reviews.map((r) => r.suggestionId));
    const mine = this.suggestions.filter((s) => s.imageId === imageId);
    const removed = new Set(mine.filter((s) => !reviewed.has(s.id)).map((s) => s.id));
    const keptArticleIds = new Set(mine.filter((s) => reviewed.has(s.id)).map((s) => s.articleId));
    this.suggestions = this.suggestions.filter((s) => !removed.has(s.id));
    this.reasons = this.reasons.filter((r) => !removed.has(r.suggestionId));

    for (const ev of evaluated) {
      if (keptArticleIds.has(ev.articleId)) continue;
      if (!this.articles.some((a) => a.id === ev.articleId)) throw new Error("foreign key violation: matching_suggestions.article_id");
      const suggestion = { id: this._id("suggestion"), imageId, articleId: ev.articleId, similarityScore: ev.similarity, rank: ev.rank, decision: ev.decision, createdAt: this.clock() };
      this.suggestions.push(suggestion);
      for (const reason of ev.reasons) {
        this.reasons.push({ id: this._id("reason"), suggestionId: suggestion.id, reasonCode: reason.code, humanExplanation: reason.explanation, signalValues: clone(reason.signals), createdAt: this.clock() });
      }
    }
  }
  async listSuggestionsForImage(imageId) {
    return this.suggestions.filter((s) => s.imageId === imageId).sort((a, b) => a.rank - b.rank).map((s) => this._hydrate(s));
  }
  async getSuggestion(id) {
    const suggestion = this.suggestions.find((s) => s.id === id);
    return suggestion ? this._hydrate(suggestion) : null;
  }
  async listSuggestions({ decision = null, reviewState = null, limit = 100 } = {}) {
    return this.suggestions
      .map((s) => this._hydrate(s))
      .filter((s) => (decision ? s.decision === decision : true))
      .filter((s) => (reviewState ? s.reviewState === reviewState : true))
      .sort((a, b) => a.id - b.id)
      .slice(0, limit);
  }

  // --- reviews ------------------------------------------------------------
  async createReview({ suggestionId, reviewer, decision, notes }) {
    if (!this.suggestions.some((s) => s.id === suggestionId)) throw new NotFoundError(`suggestion ${suggestionId} not found`);
    if (!["approved", "rejected"].includes(decision)) throw new Error("check violation: reviews.decision");
    if (typeof notes !== "string" || notes.trim().length === 0) throw new Error("check violation: reviews.notes");
    const row = { id: this._id("review"), suggestionId, reviewer, decision, notes, createdAt: this.clock() };
    this.reviews.push(row);
    return clone(row);
  }

  // --- jobs ---------------------------------------------------------------
  async enqueueJob(type, payload, { runAfter = null } = {}) {
    const now = this.clock();
    const job = { id: this._id("job"), type, payload: clone(payload), status: "queued", attempts: 0, lastError: null, runAfter: runAfter ?? now, createdAt: now, updatedAt: now };
    this.jobs.push(job);
    return job.id;
  }
  /**
   * Atomically claim the next eligible job: queued and due, or "running"
   * but stale past the visibility timeout (a crashed worker). JavaScript
   * is single-threaded, so this read-modify-write cannot interleave —
   * the same guarantee PostgresStore gets from FOR UPDATE SKIP LOCKED.
   */
  async claimNextJob({ now = this.clock(), visibilityTimeoutMs = 300000 } = {}) {
    const staleBefore = new Date(now.getTime() - visibilityTimeoutMs);
    const eligible = this.jobs
      .filter((j) => (j.status === "queued" && j.runAfter <= now) || (j.status === "running" && j.updatedAt <= staleBefore))
      .sort((a, b) => a.runAfter - b.runAfter || a.id - b.id);
    const job = eligible[0];
    if (!job) return null;
    job.status = "running";
    job.attempts += 1;
    job.updatedAt = now;
    return clone(job);
  }
  _job(id) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw new NotFoundError(`job ${id} not found`);
    return job;
  }
  async markJobDone(id) {
    const job = this._job(id);
    job.status = "done";
    job.updatedAt = this.clock();
  }
  async markJobRetry(id, { error, runAfter }) {
    const job = this._job(id);
    job.status = "queued";
    job.lastError = error;
    job.runAfter = runAfter;
    job.updatedAt = this.clock();
  }
  async markJobFailed(id, error) {
    const job = this._job(id);
    job.status = "failed";
    job.lastError = error;
    job.updatedAt = this.clock();
  }
  async getJob(id) {
    const job = this.jobs.find((j) => j.id === id);
    return job ? clone(job) : null;
  }
  async listJobs({ status = null, limit = 100 } = {}) {
    return this.jobs.filter((j) => (status ? j.status === status : true)).slice(0, limit).map(clone);
  }
}
