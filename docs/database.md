# Database

PostgreSQL 16 + pgvector. Local instance: `docker compose -f infra/docker-compose.yml up -d`.

## Commands

```bash
npm run db:status   # applied vs pending, checksum drift check; changes nothing
npm run db:migrate  # applies pending migrations; safe to re-run
```

Migrations are **never** run automatically when the API starts. `.env` at the repo root is loaded if present; otherwise use real environment variables. Output shows only `host:port/database`, never credentials, and error messages are redacted.

## Migration rules

- Files live in `apps/api/migrations/NNN_snake_case.sql`; versions are contiguous from 1.
- Each file runs in its own transaction together with its bookkeeping row in `schema_migrations(version, name, checksum, applied_at)`: failure rolls back both.
- Exception: a file whose first line is `-- migrate:no-transaction` runs outside a transaction (needed for `CREATE INDEX CONCURRENTLY`). None exist yet.
- Applied migrations are immutable: the SHA-256 checksum (CRLF-normalized) is compared on every run and a mismatch aborts. Fix mistakes with a new migration.
- A session-level advisory lock serializes concurrent runners.
- `001_init.sql` runs `CREATE EXTENSION IF NOT EXISTS vector`, which needs a role allowed to create it (the pgvector Docker image's default superuser is fine).

## Schema (001)

| Table               | Purpose                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| `articles`          | Title/body/category/tags; unique `content_hash` for idempotency                                           |
| `images`            | Image metadata (unique `sha256`, mime allow-list, size, relative storage path)                            |
| `image_embeddings`  | `embedding vector(768)`, embedding model + task type, HNSW cosine index, unique per (image, model)        |
| `analysis_jobs`     | Workflow `status` kept separate from guard `decision`; stores model prediction (jsonb), similarity, policy version/config, retry counters, error, token usage/cost estimate |
| `reviews`           | One human review per job (`UNIQUE(job_id)` blocks double review); notes required                          |
| `job_audit_events`  | Append-only history; UPDATE/DELETE/TRUNCATE are rejected by trigger                                       |

Key constraints: `completed`/`needs_review` require a decision; `needs_review` implies decision `review`; any decision requires `policy_version`; `failed` requires an error code; `attempts <= max_attempts`. Deleting an article, image or job that is referenced is restricted. Tests assert the SQL stays in sync with `EMBEDDING_DIMENSION`, `JOB_STATUSES` and `DECISIONS` from `@iam/shared`.

## Schema (002, milestone 4)

| Change | Why |
| --- | --- |
| `image_classifications` | validated vision output per image, so candidates are not re-classified; unique per (image, provider, model) |
| `article_embeddings` | `vector(768)` + HNSW cosine index, unique per (article, model); needed to rank articles for an image |
| `analysis_jobs.guard_signals`, `analysis_jobs.embedding_model` | guard signals (also for accepted matches) and the embedding model compared |

Match results reuse `analysis_jobs`, `reviews` and `job_audit_events`; no parallel suggestions table. See `docs/policy.md`.

### Integration tests

`apps/api/test/matching/integration.test.ts` runs only when `TEST_DATABASE_URL` is set. It creates a uniquely named schema (`it_<random>`), applies all migrations inside it, and drops only that schema afterwards; `public` and existing data are not touched. Use a scratch database anyway.

## Connection module

`apps/api/src/db/pool.ts`: lazy `pg.Pool` with bounded size/timeouts (`DB_*` env vars), idle-client error handler, `withTransaction`, `checkDatabase`, idempotent `closePool`. `server.ts` closes the HTTP server then the pool on SIGINT/SIGTERM. Use parameterized queries only (`$1, $2`).

## Schema (003, milestone 5)

| Change | Why |
| --- | --- |
| `analysis_jobs.kind` (`submission` / `suggestion`) | separates API-submitted jobs from milestone-4 match results; backfilled from the key prefix `suggest:`; M4 inserts now set it explicitly |
| `analysis_jobs.request_fingerprint` | detects an Idempotency-Key reused with a different payload |
| `analysis_jobs.enqueued_at` | NULL = never published to the queue (reconciler input) |
| CHECK `failed_no_decision`, `open_no_decision`, `kind_matches_key` | a failed/open job cannot carry a decision; key namespace matches kind |
| trigger `enforce_job_transition` | illegal status transitions are rejected by the database; `kind` is immutable |
| `ai_usage` | one row per real provider call; cost NULL = unknown (CHECK ties a cost to a configured-rate basis) |

### Pre-flight before `npm run db:migrate` on a database that already has data

The migration backfills first and adds constraints after, inside one transaction: a violating row aborts it and leaves the schema at version 2 (tested). Check beforehand that these return 0:

```sql
SELECT count(*) FROM analysis_jobs WHERE status = 'failed' AND decision IS NOT NULL;
SELECT count(*) FROM analysis_jobs
 WHERE idempotency_key NOT LIKE 'suggest:%' AND status IN ('queued','processing') AND decision IS NOT NULL;
```
