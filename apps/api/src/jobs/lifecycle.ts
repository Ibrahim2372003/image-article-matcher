import type { JobStatus } from "@iam/shared";

export const TERMINAL_STATUSES: readonly JobStatus[] = ["completed", "failed", "needs_review"];
export const isTerminal = (s: JobStatus): boolean => TERMINAL_STATUSES.includes(s);

/** Mirrors the database trigger `enforce_job_transition` (migration 003). */
const ALLOWED: Record<JobStatus, readonly JobStatus[]> = {
  queued: ["processing", "failed"],
  processing: ["processing", "queued", "completed", "needs_review", "failed"],
  completed: [],
  failed: [],
  needs_review: [],
};
export const canTransition = (from: JobStatus, to: JobStatus): boolean => ALLOWED[from].includes(to);

export interface BackoffConfig {
  baseMs: number;
  maxMs: number;
}

/** Bounded exponential backoff: base, 2x, 4x, ... never above maxMs. `attempt` is 1-based. */
export function computeBackoffMs(attempt: number, cfg: BackoffConfig): number {
  const n = Number.isFinite(attempt) && attempt >= 1 ? Math.floor(attempt) : 1;
  return Math.min(cfg.maxMs, cfg.baseMs * 2 ** Math.min(n - 1, 30));
}
