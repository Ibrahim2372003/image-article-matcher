import type { Pool, PoolClient } from "pg";
import type { JobStatus, JobView } from "@iam/shared";
import { toStorableSimilarity } from "../matching/types.js";
import { IdempotencyConflictError } from "./errors.js";
import type {
  ClaimResult,
  JobFailure,
  JobResult,
  JobRow,
  JobStore,
  NewSubmission,
  ReconcileCandidate,
  UsageEntry,
} from "./types.js";

type Db = Pick<Pool, "query" | "connect">;

interface RawJob {
  id: string;
  article_id: string;
  image_id: string;
  idempotency_key: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  enqueued_at: Date | null;
  created_at: Date;
  updated_at: Date;
  request_fingerprint?: string | null;
}
const JOB_COLUMNS =
  "id, article_id, image_id, idempotency_key, status, attempts, max_attempts, enqueued_at, created_at, updated_at, request_fingerprint";

const toJobRow = (r: RawJob): JobRow => ({
  id: r.id,
  articleId: r.article_id,
  imageId: r.image_id,
  idempotencyKey: r.idempotency_key,
  status: r.status,
  attempts: r.attempts,
  maxAttempts: r.max_attempts,
  enqueuedAt: r.enqueued_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

async function audit(
  c: Pick<PoolClient, "query">,
  jobId: string,
  eventType: string,
  actor: string,
  from: string | null,
  to: string | null,
  details: Record<string, unknown>,
): Promise<void> {
  await c.query(
    "INSERT INTO job_audit_events (job_id, event_type, actor, from_status, to_status, details) VALUES ($1, $2, $3, $4, $5, $6::jsonb)",
    [jobId, eventType, actor, from, to, JSON.stringify(details)],
  );
}

export class PgJobStore implements JobStore {
  constructor(private readonly db: Db) {}

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
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

  /**
   * One transaction: upsert article + image, then insert the job. The UNIQUE(idempotency_key) index serialises
   * concurrent submissions with the same key: the loser waits for the winner, gets no row from the INSERT, and
   * reads the winner's committed row. A replay with a different fingerprint is a conflict, never a silent reuse.
   */
  async createSubmission(input: NewSubmission) {
    return this.tx(async (c) => {
      const article = await c.query<{ id: string }>(
        `INSERT INTO articles (title, body, category, tags, content_hash) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (content_hash) DO UPDATE SET content_hash = EXCLUDED.content_hash RETURNING id`,
        [
          input.article.title,
          input.article.body,
          input.article.category,
          input.article.tags,
          input.article.contentHash,
        ],
      );
      const image = await c.query<{ id: string }>(
        `INSERT INTO images (sha256, mime_type, byte_size, storage_path) VALUES ($1, $2, $3, $4)
         ON CONFLICT (sha256) DO UPDATE SET sha256 = EXCLUDED.sha256 RETURNING id`,
        [input.image.sha256, input.image.mimeType, input.image.byteSize, input.image.storagePath],
      );
      const articleId = article.rows[0]?.id as string;
      const imageId = image.rows[0]?.id as string;

      const ins = await c.query<RawJob>(
        `INSERT INTO analysis_jobs (article_id, image_id, idempotency_key, kind, request_fingerprint, max_attempts)
         VALUES ($1, $2, $3, 'submission', $4, $5)
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING ${JOB_COLUMNS}`,
        [articleId, imageId, input.idempotencyKey, input.fingerprint, input.maxAttempts],
      );
      if (ins.rows[0]) {
        const job = toJobRow(ins.rows[0]);
        await audit(c, job.id, "job_submitted", "api", null, "queued", { maxAttempts: input.maxAttempts });
        return { job, outcome: "created" as const };
      }
      const existing = await c.query<RawJob>(
        `SELECT ${JOB_COLUMNS} FROM analysis_jobs WHERE idempotency_key = $1 AND kind = 'submission'`,
        [input.idempotencyKey],
      );
      const row = existing.rows[0];
      if (!row) throw new Error("idempotency key resolved to a non-submission row");
      if (row.request_fingerprint !== input.fingerprint) throw new IdempotencyConflictError(row.id);
      return { job: toJobRow(row), outcome: "replayed" as const };
    });
  }

  async markEnqueued(jobId: string, actor: string): Promise<void> {
    await this.tx(async (c) => {
      const r = await c.query<{ status: JobStatus }>(
        "UPDATE analysis_jobs SET enqueued_at = now() WHERE id = $1 AND kind = 'submission' RETURNING status",
        [jobId],
      );
      if (r.rows[0]) await audit(c, jobId, "job_enqueued", actor, r.rows[0].status, r.rows[0].status, {});
    });
  }

  /**
   * queued|processing -> processing with attempts+1, under a row lock. `attempts` is the fencing token: every later
   * write is conditional on it, so a worker that lost the job (crash, redelivery, requeue) cannot overwrite the
   * newer attempt. A job that has already used all its attempts is failed here instead of being run again.
   */
  async claim(jobId: string): Promise<ClaimResult> {
    return this.tx(async (c) => {
      const locked = await c.query<RawJob>(
        `SELECT ${JOB_COLUMNS} FROM analysis_jobs WHERE id = $1 AND kind = 'submission' FOR UPDATE`,
        [jobId],
      );
      const row = locked.rows[0];
      if (!row) return { kind: "missing" } as const;
      if (row.status === "completed" || row.status === "failed" || row.status === "needs_review") {
        return { kind: "terminal", status: row.status } as const;
      }
      if (row.attempts >= row.max_attempts) {
        await c.query(
          `UPDATE analysis_jobs SET status = 'failed', last_error_code = 'attempts_exceeded',
             last_error_message = 'all attempts were used without a recorded outcome (a worker likely crashed)', completed_at = now()
           WHERE id = $1`,
          [jobId],
        );
        await audit(c, jobId, "job_failed", "worker", row.status, "failed", {
          reason: "attempts_exceeded",
          attempts: row.attempts,
        });
        return { kind: "exhausted" } as const;
      }
      const upd = await c.query<RawJob>(
        `UPDATE analysis_jobs SET status = 'processing', attempts = attempts + 1, started_at = now()
         WHERE id = $1 RETURNING ${JOB_COLUMNS}`,
        [jobId],
      );
      const job = toJobRow(upd.rows[0] as RawJob);
      await audit(c, jobId, "job_claimed", "worker", row.status, "processing", { attempt: job.attempts });
      return { kind: "claimed", job, attempt: job.attempts } as const;
    });
  }

  async commitResult(jobId: string, attempt: number, r: JobResult): Promise<boolean> {
    const status: JobStatus = r.decision === "review" ? "needs_review" : "completed";
    return this.tx(async (c) => {
      const upd = await c.query(
        `UPDATE analysis_jobs SET status = $2, model_provider = $3, model_name = $4, model_prediction = $5::jsonb, similarity = $6,
           decision = $7, decision_reasons = $8::jsonb, policy_version = $9, policy_config = $10::jsonb, guard_signals = $11::jsonb,
           embedding_model = $12, last_error_code = NULL, last_error_message = NULL, completed_at = now()
         WHERE id = $1 AND kind = 'submission' AND status = 'processing' AND attempts = $13 RETURNING id`,
        [
          jobId,
          status,
          r.classification.provider,
          r.classification.model,
          JSON.stringify({
            category: r.classification.category,
            tags: r.classification.tags,
            confidence: r.classification.confidence,
          }),
          toStorableSimilarity(r.similarity),
          r.decision,
          JSON.stringify(r.reasons),
          r.policyVersion,
          JSON.stringify(r.policyConfig),
          JSON.stringify(r.signals),
          r.embeddingModel,
          attempt,
        ],
      );
      if ((upd.rowCount ?? 0) === 0) return false;
      await audit(c, jobId, "job_completed", "worker", "processing", status, {
        attempt,
        decision: r.decision,
        primaryReasonCode: r.signals.primaryReasonCode,
        policyVersion: r.policyVersion,
      });
      return true;
    });
  }

  async recordRetry(jobId: string, attempt: number, f: JobFailure): Promise<boolean> {
    return this.tx(async (c) => {
      const upd = await c.query(
        `UPDATE analysis_jobs SET status = 'queued', last_error_code = $2, last_error_message = $3
         WHERE id = $1 AND kind = 'submission' AND status = 'processing' AND attempts = $4 RETURNING id`,
        [jobId, f.code, f.message, attempt],
      );
      if ((upd.rowCount ?? 0) === 0) return false;
      await audit(c, jobId, "retry_scheduled", "worker", "processing", "queued", { attempt, code: f.code });
      return true;
    });
  }

  async failPermanently(jobId: string, attempt: number, f: JobFailure, opts: { exhausted: boolean }): Promise<boolean> {
    return this.tx(async (c) => {
      const upd = await c.query(
        `UPDATE analysis_jobs SET status = 'failed', last_error_code = $2, last_error_message = $3, completed_at = now()
         WHERE id = $1 AND kind = 'submission' AND status = 'processing' AND attempts = $4 RETURNING id`,
        [jobId, f.code, f.message, attempt],
      );
      if ((upd.rowCount ?? 0) === 0) return false;
      await audit(c, jobId, "job_failed", "worker", "processing", "failed", {
        attempt,
        code: f.code,
        retryable: f.retryable,
        exhausted: opts.exhausted,
      });
      return true;
    });
  }

  async recordUsage(e: UsageEntry): Promise<void> {
    await this.db.query(
      `INSERT INTO ai_usage (job_id, attempt, operation, provider, model, success, error_code, latency_ms,
         input_tokens, output_tokens, tokens_estimated, estimated_cost_usd, cost_basis)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        e.jobId,
        e.attempt,
        e.operation,
        e.provider,
        e.model,
        e.success,
        e.errorCode,
        Math.max(0, Math.round(e.latencyMs)),
        e.usage?.inputTokens ?? null,
        e.usage?.outputTokens ?? null,
        e.usage?.estimated ?? false,
        e.estimatedCostUsd,
        e.costBasis,
      ],
    );
  }

  async getJobView(jobId: string): Promise<JobView | null> {
    const job = await this.db.query<{
      id: string;
      status: JobStatus;
      attempts: number;
      max_attempts: number;
      article_id: string;
      image_id: string;
      decision: JobView["decision"];
      similarity: number | null;
      decision_reasons: JobView["reasons"];
      guard_signals: JobView["signals"];
      policy_version: string | null;
      embedding_model: string | null;
      model_prediction: JobView["classification"];
      last_error_code: string | null;
      last_error_message: string | null;
      created_at: Date;
      updated_at: Date;
      started_at: Date | null;
      completed_at: Date | null;
    }>(
      `SELECT id, status, attempts, max_attempts, article_id, image_id, decision, similarity, decision_reasons, guard_signals,
              policy_version, embedding_model, model_prediction, last_error_code, last_error_message,
              created_at, updated_at, started_at, completed_at
       FROM analysis_jobs WHERE id = $1 AND kind = 'submission'`,
      [jobId],
    );
    const r = job.rows[0];
    if (!r) return null;
    const u = await this.db.query<{
      calls: string;
      failed: string;
      input_tokens: string | null;
      output_tokens: string | null;
      any_estimated: boolean | null;
      known_cost: string | null;
      unknown_cost_calls: string;
      known_cost_calls: string;
    }>(
      `SELECT count(*) AS calls, count(*) FILTER (WHERE NOT success) AS failed,
              sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens, bool_or(tokens_estimated) AS any_estimated,
              sum(estimated_cost_usd) AS known_cost,
              count(*) FILTER (WHERE cost_basis <> 'configured_rate_estimate') AS unknown_cost_calls,
              count(*) FILTER (WHERE cost_basis = 'configured_rate_estimate') AS known_cost_calls
       FROM ai_usage WHERE job_id = $1`,
      [jobId],
    );
    const s = u.rows[0];
    const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
    return {
      id: r.id,
      kind: "submission",
      status: r.status,
      attempts: r.attempts,
      maxAttempts: r.max_attempts,
      articleId: r.article_id,
      imageId: r.image_id,
      decision: r.decision,
      similarity: r.similarity === null ? null : Number(r.similarity),
      reasons: r.decision_reasons ?? [],
      signals: r.guard_signals,
      policyVersion: r.policy_version,
      embeddingModel: r.embedding_model,
      classification: r.model_prediction,
      error: r.last_error_code ? { code: r.last_error_code, message: r.last_error_message ?? "" } : null,
      usage: {
        calls: Number(s?.calls ?? 0),
        failedCalls: Number(s?.failed ?? 0),
        inputTokens: s?.input_tokens == null ? null : Number(s.input_tokens),
        outputTokens: s?.output_tokens == null ? null : Number(s.output_tokens),
        tokensEstimated: s?.any_estimated === true,
        estimatedCostUsd: Number(s?.known_cost_calls ?? 0) > 0 ? Number(s?.known_cost) : null,
        costComplete: Number(s?.unknown_cost_calls ?? 0) === 0,
      },
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
      startedAt: iso(r.started_at),
      completedAt: iso(r.completed_at),
    };
  }

  async findReconcileCandidates(o: {
    queuedStaleMs: number;
    processingStaleMs: number;
    limit: number;
  }): Promise<ReconcileCandidate[]> {
    const { rows } = await this.db.query<{ id: string; status: JobStatus; attempts: number; max_attempts: number }>(
      `SELECT id, status, attempts, max_attempts FROM analysis_jobs
       WHERE kind = 'submission'
         AND ((status = 'queued' AND updated_at < now() - make_interval(secs => $1))
           OR (status = 'processing' AND updated_at < now() - make_interval(secs => $2)))
       ORDER BY updated_at LIMIT $3`,
      [o.queuedStaleMs / 1000, o.processingStaleMs / 1000, o.limit],
    );
    return rows.map((r) => ({ id: r.id, status: r.status, attempts: r.attempts, maxAttempts: r.max_attempts }));
  }

  async recordRequeued(jobId: string, previousStatus: JobStatus): Promise<void> {
    await this.tx(async (c) => {
      const r = await c.query("UPDATE analysis_jobs SET enqueued_at = now() WHERE id = $1 AND kind = 'submission'", [
        jobId,
      ]);
      if ((r.rowCount ?? 0) > 0)
        await audit(c, jobId, "job_requeued", "reconciler", previousStatus, previousStatus, { previousStatus });
    });
  }
}
