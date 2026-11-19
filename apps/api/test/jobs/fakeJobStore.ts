import { randomUUID } from "node:crypto";
import type { JobStatus, JobView } from "@iam/shared";
import { IdempotencyConflictError } from "../../src/jobs/errors.js";
import { canTransition, isTerminal } from "../../src/jobs/lifecycle.js";
import type {
  ClaimResult,
  JobFailure,
  JobResult,
  JobRow,
  JobStore,
  NewSubmission,
  ReconcileCandidate,
  UsageEntry,
} from "../../src/jobs/types.js";

interface Row extends JobRow {
  fingerprint: string;
  decision: string | null;
  result: JobResult | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: Date | null;
}

/** In-memory JobStore with the same state machine, fencing and idempotency rules as PgJobStore, plus fault injection. */
export class FakeJobStore implements JobStore {
  rows = new Map<string, Row>();
  byKey = new Map<string, string>();
  usage: UsageEntry[] = [];
  events: Array<{ jobId: string; type: string; from: string | null; to: string | null }> = [];
  enqueued: string[] = [];
  requeued: string[] = [];
  failures: { recordRetry?: boolean; commitResult?: boolean; recordUsage?: boolean; claim?: boolean } = {};

  private log(jobId: string, type: string, from: string | null, to: string | null) {
    this.events.push({ jobId, type, from, to });
  }
  private move(r: Row, to: JobStatus) {
    if (r.status !== to && !canTransition(r.status, to)) throw new Error(`illegal transition ${r.status} -> ${to}`);
    r.status = to;
    r.updatedAt = new Date();
  }

  /** Test helper: a queued job exactly as `createSubmission` would leave it. */
  seed(
    over: Partial<{
      id: string;
      articleId: string;
      imageId: string;
      maxAttempts: number;
      status: JobStatus;
      attempts: number;
      updatedAt: Date;
      enqueuedAt: Date | null;
    }> = {},
  ): Row {
    const id = over.id ?? randomUUID();
    const row: Row = {
      id,
      articleId: over.articleId ?? "a1",
      imageId: over.imageId ?? "i1",
      idempotencyKey: `submit:${id}`,
      status: over.status ?? "queued",
      attempts: over.attempts ?? 0,
      maxAttempts: over.maxAttempts ?? 3,
      enqueuedAt: over.enqueuedAt ?? null,
      createdAt: new Date(),
      updatedAt: over.updatedAt ?? new Date(),
      fingerprint: id,
      decision: null,
      result: null,
      errorCode: null,
      errorMessage: null,
      startedAt: null,
    };
    this.rows.set(id, row);
    this.byKey.set(row.idempotencyKey, id);
    return row;
  }

  async createSubmission(input: NewSubmission) {
    const existingId = this.byKey.get(input.idempotencyKey);
    if (existingId) {
      const r = this.rows.get(existingId)!;
      if (r.fingerprint !== input.fingerprint) throw new IdempotencyConflictError(r.id);
      return { job: { ...r }, outcome: "replayed" as const };
    }
    const row = this.seed({
      articleId: input.article.contentHash,
      imageId: input.image.sha256,
      maxAttempts: input.maxAttempts,
    });
    this.byKey.delete(row.idempotencyKey);
    row.idempotencyKey = input.idempotencyKey;
    row.fingerprint = input.fingerprint;
    this.byKey.set(input.idempotencyKey, row.id);
    this.log(row.id, "job_submitted", null, "queued");
    return { job: { ...row }, outcome: "created" as const };
  }
  async markEnqueued(jobId: string) {
    const r = this.rows.get(jobId);
    if (r) r.enqueuedAt = new Date();
    this.enqueued.push(jobId);
  }
  async claim(jobId: string): Promise<ClaimResult> {
    if (this.failures.claim) throw Object.assign(new Error("db down"), { code: "08006", severity: "ERROR" });
    const r = this.rows.get(jobId);
    if (!r) return { kind: "missing" };
    if (isTerminal(r.status)) return { kind: "terminal", status: r.status };
    if (r.attempts >= r.maxAttempts) {
      this.move(r, "failed");
      r.errorCode = "attempts_exceeded";
      this.log(jobId, "job_failed", "processing", "failed");
      return { kind: "exhausted" };
    }
    const from = r.status;
    this.move(r, "processing");
    r.attempts += 1;
    r.startedAt = new Date();
    this.log(jobId, "job_claimed", from, "processing");
    return { kind: "claimed", job: { ...r }, attempt: r.attempts };
  }
  private owns(r: Row | undefined, attempt: number): r is Row {
    return !!r && r.status === "processing" && r.attempts === attempt;
  }
  async commitResult(jobId: string, attempt: number, result: JobResult) {
    if (this.failures.commitResult) throw Object.assign(new Error("db down"), { code: "08006", severity: "ERROR" });
    const r = this.rows.get(jobId);
    if (!this.owns(r, attempt)) return false;
    this.move(r, result.decision === "review" ? "needs_review" : "completed");
    r.decision = result.decision;
    r.result = result;
    r.errorCode = null;
    this.log(jobId, "job_completed", "processing", r.status);
    return true;
  }
  async recordRetry(jobId: string, attempt: number, f: JobFailure) {
    if (this.failures.recordRetry) throw Object.assign(new Error("db down"), { code: "08006", severity: "ERROR" });
    const r = this.rows.get(jobId);
    if (!this.owns(r, attempt)) return false;
    this.move(r, "queued");
    r.errorCode = f.code;
    r.errorMessage = f.message;
    this.log(jobId, "retry_scheduled", "processing", "queued");
    return true;
  }
  async failPermanently(jobId: string, attempt: number, f: JobFailure) {
    const r = this.rows.get(jobId);
    if (!this.owns(r, attempt)) return false;
    this.move(r, "failed");
    r.errorCode = f.code;
    r.errorMessage = f.message;
    r.decision = null;
    this.log(jobId, "job_failed", "processing", "failed");
    return true;
  }
  async recordUsage(e: UsageEntry) {
    if (this.failures.recordUsage) throw new Error("ledger down");
    this.usage.push(e);
  }
  async getJobView(jobId: string): Promise<JobView | null> {
    const r = this.rows.get(jobId);
    if (!r) return null;
    const u = this.usage.filter((x) => x.jobId === jobId);
    const known = u.filter((x) => x.costBasis === "configured_rate_estimate");
    return {
      id: r.id,
      kind: "submission",
      status: r.status,
      attempts: r.attempts,
      maxAttempts: r.maxAttempts,
      articleId: "00000000-0000-4000-8000-000000000001",
      imageId: "00000000-0000-4000-8000-000000000002",
      decision: (r.decision as JobView["decision"]) ?? null,
      similarity: r.result?.similarity ?? null,
      reasons: r.result?.reasons ?? [],
      signals: (r.result?.signals as unknown as Record<string, unknown>) ?? null,
      policyVersion: r.result?.policyVersion ?? null,
      embeddingModel: r.result?.embeddingModel ?? null,
      classification: r.result
        ? {
            category: r.result.classification.category,
            tags: r.result.classification.tags,
            confidence: r.result.classification.confidence,
          }
        : null,
      error: r.errorCode ? { code: r.errorCode, message: r.errorMessage ?? "" } : null,
      usage: {
        calls: u.length,
        failedCalls: u.filter((x) => !x.success).length,
        inputTokens: u.length ? u.reduce((s, x) => s + (x.usage?.inputTokens ?? 0), 0) : null,
        outputTokens: u.length ? u.reduce((s, x) => s + (x.usage?.outputTokens ?? 0), 0) : null,
        tokensEstimated: u.some((x) => x.usage?.estimated),
        estimatedCostUsd: known.length ? known.reduce((s, x) => s + (x.estimatedCostUsd ?? 0), 0) : null,
        costComplete: u.every((x) => x.costBasis === "configured_rate_estimate"),
      },
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      startedAt: r.startedAt?.toISOString() ?? null,
      completedAt: isTerminal(r.status) ? r.updatedAt.toISOString() : null,
    };
  }
  async findReconcileCandidates(o: {
    queuedStaleMs: number;
    processingStaleMs: number;
    limit: number;
  }): Promise<ReconcileCandidate[]> {
    const now = Date.now();
    return [...this.rows.values()]
      .filter(
        (r) =>
          (r.status === "queued" && now - r.updatedAt.getTime() >= o.queuedStaleMs) ||
          (r.status === "processing" && now - r.updatedAt.getTime() >= o.processingStaleMs),
      )
      .slice(0, o.limit)
      .map((r) => ({ id: r.id, status: r.status, attempts: r.attempts, maxAttempts: r.maxAttempts }));
  }
  async recordRequeued(jobId: string) {
    const r = this.rows.get(jobId);
    if (r) {
      r.enqueuedAt = new Date();
      r.updatedAt = new Date();
    }
    this.requeued.push(jobId);
  }
}
