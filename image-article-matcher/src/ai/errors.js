/**
 * An error from an AI provider. `retryable` tells the job worker whether
 * trying again could plausibly help: a 429/5xx or a dropped connection
 * can; a 401 (bad key) or a safety block cannot. `usage` carries token
 * counts when the provider managed to report them before failing, so a
 * failed-but-billed call is still cost-tracked.
 */
export class ProviderError extends Error {
  constructor(message, { retryable = true, status = null, usage = null } = {}) {
    super(message);
    this.name = "ProviderError";
    this.retryable = retryable;
    this.status = status;
    this.usage = usage;
  }
}

/** The model answered, but its structured output failed Zod validation. Retryable: the next sample may be valid. */
export class OutputValidationError extends Error {
  constructor(message, { usage = null } = {}) {
    super(message);
    this.name = "OutputValidationError";
    this.retryable = true;
    this.usage = usage;
  }
}

/** A problem retrying cannot fix (missing prerequisite data, bad configuration). */
export class PermanentError extends Error {
  constructor(message) {
    super(message);
    this.name = "PermanentError";
    this.retryable = false;
  }
}

/** A referenced row does not exist. Routes map this to HTTP 404. */
export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotFoundError";
    this.retryable = false;
  }
}
