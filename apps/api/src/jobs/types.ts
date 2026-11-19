import type { Decision, JobStatus, JobView, VisionClassification } from "@iam/shared";
import type { GuardConfig, GuardReason, GuardSignals } from "../matching/guard.js";
import type { ProviderUsage } from "../ai/types.js";

export type UsageOperation = "classify_image" | "embed_image" | "embed_article";
export type CostBasis = "no_rate_configured" | "tokens_unavailable" | "configured_rate_estimate";

export interface JobRow {
  id: string;
  articleId: string;
  imageId: string;
  idempotencyKey: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  enqueuedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewSubmission {
  article: { title: string; body: string; category: string | null; tags: string[]; contentHash: string };
  image: { sha256: string; mimeType: "image/png" | "image/jpeg" | "image/webp"; byteSize: number; storagePath: string };
  idempotencyKey: string;
  fingerprint: string;
  maxAttempts: number;
}

export type ClaimResult =
  | { kind: "claimed"; job: JobRow; attempt: number }
  | { kind: "terminal"; status: JobStatus }
  | { kind: "exhausted" }
  | { kind: "missing" };

export interface JobFailure {
  /** Stable machine-readable code (see failure.ts). */
  code: string;
  retryable: boolean;
  message: string;
}

export interface JobResult {
  decision: Decision;
  similarity: number;
  reasons: GuardReason[];
  signals: GuardSignals & { rank: number; primaryReasonCode: string | null; embeddingTaskType: string };
  policyVersion: string;
  policyConfig: GuardConfig;
  embeddingModel: string;
  classification: VisionClassification & { provider: string; model: string };
}

export interface UsageEntry {
  jobId: string;
  attempt: number;
  operation: UsageOperation;
  provider: string;
  model: string;
  success: boolean;
  errorCode: string | null;
  latencyMs: number;
  usage: ProviderUsage | null;
  estimatedCostUsd: number | null;
  costBasis: CostBasis;
}

export interface ReconcileCandidate {
  id: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
}

/** Persistence boundary for jobs. Unit tests use a fake; production uses `PgJobStore`. */
export interface JobStore {
  createSubmission(input: NewSubmission): Promise<{ job: JobRow; outcome: "created" | "replayed" }>;
  markEnqueued(jobId: string, actor: string): Promise<void>;
  claim(jobId: string): Promise<ClaimResult>;
  /** Each returns false when the job is no longer in the expected (processing, attempt) state: the caller was superseded. */
  commitResult(jobId: string, attempt: number, result: JobResult): Promise<boolean>;
  recordRetry(jobId: string, attempt: number, failure: JobFailure): Promise<boolean>;
  failPermanently(jobId: string, attempt: number, failure: JobFailure, opts: { exhausted: boolean }): Promise<boolean>;
  recordUsage(entry: UsageEntry): Promise<void>;
  getJobView(jobId: string): Promise<JobView | null>;
  findReconcileCandidates(opts: {
    queuedStaleMs: number;
    processingStaleMs: number;
    limit: number;
  }): Promise<ReconcileCandidate[]>;
  recordRequeued(jobId: string, previousStatus: JobStatus): Promise<void>;
}
