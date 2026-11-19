# Asynchronous job pipeline and HTTP API (milestone 5)

PostgreSQL is the **source of truth**. Redis/BullMQ only **delivers job ids** to workers; a queue payload is `{ "jobId": "<uuid>" }` and nothing else (no article text, no image data, no secrets).

```
client --POST /jobs--> API --(1) store image, (2) insert job row, (3) publish id--> Redis/BullMQ --> worker
                                                                                              |
                       GET /jobs/:id <------------- PostgreSQL <---- guarded writes + audit ---+
```

Code: `apps/api/src/jobs/`, `storage/`, `http/`, `routes/`, entry points `server.ts` (API) and `worker.ts` (separate process).

## Lifecycle

| From | To | When |
| --- | --- | --- |
| `queued` | `processing` | a worker claims it (`attempts` + 1) |
| `processing` | `processing` | re-claim after a crash/redelivery (`attempts` + 1) |
| `processing` | `queued` | transient failure; retry scheduled (error recorded, **no decision**) |
| `processing` | `completed` / `needs_review` | guard decision persisted (`review` => `needs_review`) |
| `processing` / `queued` | `failed` | permanent failure, retries exhausted, or attempts used up |

`completed`, `failed` and `needs_review` are terminal for processing. Transitions are enforced twice: by guarded `UPDATE ... WHERE status/attempts` in code and by a database trigger (`enforce_job_transition`). Every transition writes an append-only `job_audit_events` row.

**A failed job has `status = failed` and `decision = NULL`** (database CHECK). Infrastructure and AI failures are never content decisions; consumers must treat "no decision" as "not approved".

## Idempotency and duplicates

* Default key `submit:<articleHash>:<imageSha256>`: the same article and image are the same job. A client may send `Idempotency-Key` (`[A-Za-z0-9._~-]`, max 128, stored as `client:<key>`); reusing it with a different article/image is `409`.
* The job insert uses `UNIQUE(idempotency_key)`, so concurrent identical submissions create exactly one job.
* Two explicit keys for the same payload are two jobs (the caller asked for that).
* Duplicate queue deliveries are harmless: `claim` refuses terminal jobs, and the attempt number is a **fencing token**: every write (`commit`, `retry`, `fail`) is conditional on `attempts` matching the claim, so a stale worker cannot overwrite a newer attempt.

## The insert-succeeded / publish-failed window

1. The job row is written first (`queued`, `enqueued_at` NULL).
2. If publishing fails or times out, the API answers `503 queue_unavailable` (with the job id). A retry of the same request publishes the existing job.
3. If nobody retries, the **reconciler** (in the worker process) finds stale open jobs, asks the queue to guarantee a live entry, and records the requeue. A live entry (delayed retry, running job) is left alone, so it never double-runs a job. A finished BullMQ leftover is removed and re-added (BullMQ would otherwise ignore the same id).
4. Queue operations have a deadline (`QUEUE_PUBLISH_TIMEOUT_MS`): BullMQ otherwise waits forever for Redis. During an outage the reconciler skips the pass.

## Retry policy

* Retry only classified transient errors: provider timeout / 429 / 5xx / network, malformed or schema-invalid model output, transient database errors, unknown internal errors (bounded).
* Never retried: configuration, input, invalid embedding (e.g. wrong dimension), matching errors (missing prerequisite, incompatible embedding space), missing/oversized/unsupported image, database constraint violations.
* Bounded: `JOB_MAX_ATTEMPTS` (1-10, default 3) in the database; exponential backoff `JOB_BACKOFF_BASE_MS` doubling up to `JOB_BACKOFF_MAX_MS`. The last attempt fails the job (`exhausted`) instead of retrying. A job whose attempts were all consumed by crashed workers is failed at the next claim (`attempts_exceeded`).
* Stable error codes (`provider_timeout`, `provider_invalid_embedding`, `matching_missing_prerequisite`, `image_not_found`, `db_unavailable`, `internal_error`, ...) are stored in `last_error_code`.

## Pipeline and guard

claim -> classify image -> embed image -> embed article -> **exact pair evaluation** -> one guarded write. `evaluatePair` evaluates the submitted image against the submitted article even when that article is outside the top-K, using the unchanged Mismatch Guard (same thresholds, reason codes, ranking and tie-break). Steps already stored by an earlier attempt are reused and make no AI call.

## AI usage and cost

`ai_usage` has one row per **real** provider call, success or failure (provider, model, latency, reported tokens, outcome, stable error code). Reused results create no row. Cost is **unknown (NULL) unless** `AI_PRICING_JSON` has a rate for the model **and** the provider reported (not estimated) token counts; there are no built-in prices. `GET /jobs/:id` reports `estimatedCostUsd` as the sum of known costs only, `null` when none, and `costComplete: false` when any call's cost is unknown.

## Image uploads

multipart field `image`; size limit `MAX_UPLOAD_BYTES`; PNG/JPEG/WebP only, decided from the file's **magic bytes** (client MIME type and file name are ignored); stored as `<sha256>.<ext>` under `IMAGE_STORAGE_DIR` (gitignored) via a private temp file + atomic rename; flat names only, traversal and symlink escape refused when reading. A signature check is not a decode: a crafted file that starts with a valid image header passes (it is only stored and sent to the AI provider, never executed or served).

## HTTP API

All errors: `{ "error": { "code", "message", "requestId", "details?" } }`. Submitted values are never echoed; unexpected errors are a generic 500.

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | none | liveness |
| `GET /ready` | none | `{status, checks:{database, queue}}`, 503 if either is down |
| `POST /jobs` | `X-API-Key` | multipart: `title`, `body`, optional `category`, optional `tags` (JSON array string), file `image`; optional `Idempotency-Key`. `202` new, `200` replay |
| `GET /jobs/:id` | `X-API-Key` | status, attempts, decision/reasons/signals, classification, error, usage summary |

Statuses: 400 validation / bad id / bad key, 401, 404, 409 key conflict, 413 too large, 415 wrong media or image type, 429 (in-memory limiter per API process), 503 queue unavailable or **API key not configured (the API fails closed)**. In production the API refuses to start without `API_KEY`.

## Running it

```bash
npm run db:migrate           # applies 003 (see docs/database.md pre-flight)
npm run dev:api              # or: npm run build && node apps/api/dist/server.js
npm run dev:worker           # separate process: npm run worker after build
curl -H "X-API-Key: $API_KEY" -F title=T -F body=B -F image=@photo.png http://localhost:3000/jobs
```

Shutdown (SIGINT/SIGTERM): API stops HTTP, then closes the queue, Redis and the pool; the worker stops the reconciler, waits for active jobs, then closes the queue, Redis and the pool. `SHUTDOWN_TIMEOUT_MS` (default 60 s) must exceed the slowest job (up to 3 AI calls x `AI_TIMEOUT_MS`); in Docker set `stop_grace_period` at least that long. If it elapses the process exits 1; an interrupted job stays `processing` and is recovered by BullMQ's stalled check or the reconciler, and its attempt counter prevents endless crash loops.

## Tests that need real services

```bash
# PostgreSQL (disposable it_<random> schemas only; use a scratch database)
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/scratch npm test
# Redis (own uniquely named queue, removed afterwards)
TEST_REDIS_URL=redis://localhost:6379 npm test -- apps/api/test/jobs/queue.integration
```

## Known limitations

* A result is stored only after its provider call returns, so a crash between the call and the store re-spends that one call on the next attempt. The usage ledger may under-count if a ledger write fails (it never over-counts or invents values). Provider calls cannot be cancelled mid-flight.
* The rate limiter is in memory (per process, resets on restart).
* Stored image files are never garbage-collected; `needs_review` stays terminal until milestone 6 defines review.
* `AMBIGUOUS_MATCH` compares against the whole corpus (see `docs/policy.md`).
* BullMQ 6.7.6 with ioredis 6.0.0 (BullMQ's own development version): the real-Redis behaviour has not been exercised in the build sandbox.
* The dev/worker/db scripts use Node's `--env-file-if-exists`; if your Node version rejects it, export the variables instead.
