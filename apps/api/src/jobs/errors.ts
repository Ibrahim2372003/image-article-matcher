/** Domain errors of the job layer. The HTTP layer maps them to status codes. */
export class JobError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** The same Idempotency-Key was used for a different article/image. */
export class IdempotencyConflictError extends JobError {
  constructor(readonly existingJobId: string) {
    super("idempotency_conflict", "This Idempotency-Key was already used with a different article or image");
  }
}

export class InvalidIdempotencyKeyError extends JobError {
  constructor() {
    super("invalid_idempotency_key", "Idempotency-Key must be 1-128 characters of A-Z a-z 0-9 . _ ~ -");
  }
}

/** The job row exists (status queued) but could not be published to the queue. Safe to retry with the same key. */
export class QueueUnavailableError extends JobError {
  constructor(readonly jobId: string) {
    super("queue_unavailable", "The job was stored but could not be queued; retry with the same Idempotency-Key");
  }
}
