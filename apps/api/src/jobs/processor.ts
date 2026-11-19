import type { JobStatus } from "@iam/shared";
import type { AiProvider } from "../ai/types.js";
import { IncompatibleEmbeddingModelError } from "../matching/errors.js";
import type { GuardConfig } from "../matching/guard.js";
import { evaluatePair } from "../matching/pair.js";
import {
  ensureArticleEmbedding,
  ensureImageClassification,
  ensureImageEmbedding,
  type LoadImage,
} from "../matching/prepare.js";
import { describeSpace, sameSpace, type MatchStore } from "../matching/types.js";
import { classifyError } from "./failure.js";
import type { JobFailure, JobResult, JobStore, UsageOperation } from "./types.js";
import { withUsageTracking, type PricingTable } from "./usage.js";

export type Logger = (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;

export interface ProcessorDeps {
  jobs: JobStore;
  matches: MatchStore;
  provider: AiProvider;
  loadImage: LoadImage;
  guardConfig: GuardConfig;
  pricing: PricingTable;
  log: Logger;
}

/**
 * What happened to one delivery. The processor never throws for a classified outcome; the queue adapter turns
 * `retry` into a delayed retry and `failed` into "do not retry". A queue message can therefore never decide
 * a job's fate: only the database row can.
 */
export type ProcessOutcome =
  | { kind: "completed"; status: Extract<JobStatus, "completed" | "needs_review">; decision: string; aiCalls: number }
  | { kind: "skipped"; reason: "terminal" | "missing" }
  | { kind: "superseded" }
  | { kind: "retry"; failure: JobFailure; attempt: number }
  | { kind: "failed"; failure: JobFailure; attempt: number };

/**
 * claim (attempt+1, fencing token) -> classify image -> embed image -> embed article -> exact pair evaluation with the
 * unchanged guard -> ONE guarded write of the final result. A decision exists only on the success path, so a failed
 * pipeline can never yield accept/reject/review. Steps that already completed in an earlier attempt are reused
 * (and make no AI call). KNOWN LIMIT: a result is stored only after its provider call returns, so a crash between
 * the call and the store re-spends that one call on the next attempt; both calls appear in the usage ledger
 * only if the first one's ledger row was written.
 */
export async function processJob(jobId: string, deps: ProcessorDeps): Promise<ProcessOutcome> {
  const claim = await deps.jobs.claim(jobId);
  if (claim.kind === "missing") {
    deps.log("warn", "job row not found; dropping delivery", { jobId });
    return { kind: "skipped", reason: "missing" };
  }
  if (claim.kind === "terminal") return { kind: "skipped", reason: "terminal" };
  if (claim.kind === "exhausted") {
    return {
      kind: "failed",
      attempt: 0,
      failure: {
        code: "attempts_exceeded",
        retryable: false,
        message: "all attempts were used without a recorded outcome",
      },
    };
  }

  const { job, attempt } = claim;
  let aiCalls = 0;
  const track = (operation: UsageOperation): AiProvider =>
    withUsageTracking(deps.provider, {
      jobId,
      attempt,
      operation,
      pricing: deps.pricing,
      record: async (entry) => {
        aiCalls += 1;
        await deps.jobs.recordUsage(entry);
      },
      onRecordError: (err) => deps.log("warn", "could not record AI usage", { jobId, code: classifyError(err).code }),
    });

  try {
    const classification = await ensureImageClassification({
      store: deps.matches,
      provider: track("classify_image"),
      imageId: job.imageId,
      loadImage: deps.loadImage,
    });
    const image = await ensureImageEmbedding({
      store: deps.matches,
      provider: track("embed_image"),
      imageId: job.imageId,
    });
    const article = await ensureArticleEmbedding({
      store: deps.matches,
      provider: track("embed_article"),
      articleId: job.articleId,
    });
    if (!sameSpace(image.space, article.space)) {
      throw new IncompatibleEmbeddingModelError(
        describeSpace(image.space),
        [describeSpace(article.space)],
        "the article",
      );
    }

    const pair = await evaluatePair({
      store: deps.matches,
      imageId: job.imageId,
      articleId: job.articleId,
      space: image.space,
      guardConfig: deps.guardConfig,
    });
    const result: JobResult = {
      decision: pair.result.decision,
      similarity: pair.similarity,
      reasons: pair.result.reasons,
      signals: {
        ...pair.result.signals,
        rank: pair.rank,
        primaryReasonCode: pair.result.primaryReasonCode,
        embeddingTaskType: pair.space.taskType,
      },
      policyVersion: pair.result.policyVersion,
      policyConfig: pair.guardConfig,
      embeddingModel: pair.space.model,
      classification: {
        category: classification.category,
        tags: classification.tags,
        confidence: classification.confidence,
        provider: classification.provider,
        model: classification.model,
      },
    };
    if (!(await deps.jobs.commitResult(jobId, attempt, result))) {
      deps.log("warn", "result discarded: a newer attempt owns this job", { jobId, attempt });
      return { kind: "superseded" };
    }
    return {
      kind: "completed",
      status: result.decision === "review" ? "needs_review" : "completed",
      decision: result.decision,
      aiCalls,
    };
  } catch (err) {
    const failure = classifyError(err);
    const finalAttempt = attempt >= job.maxAttempts;
    // If persisting the outcome itself fails (database down) the error propagates: the delivery is retried by the
    // queue and the next claim re-enters from `processing`, so nothing is lost and no wrong state is written.
    if (failure.retryable && !finalAttempt) {
      if (!(await deps.jobs.recordRetry(jobId, attempt, failure))) return { kind: "superseded" };
      deps.log("warn", "transient failure; retry scheduled", { jobId, attempt, code: failure.code });
      return { kind: "retry", failure, attempt };
    }
    const exhausted = failure.retryable && finalAttempt;
    if (!(await deps.jobs.failPermanently(jobId, attempt, failure, { exhausted }))) return { kind: "superseded" };
    deps.log("error", exhausted ? "attempts exhausted" : "permanent failure", { jobId, attempt, code: failure.code });
    return { kind: "failed", failure, attempt };
  }
}
