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

Article embeddings are not stored yet; the matching design (milestone 4) will add a migration if needed.

## Connection module

`apps/api/src/db/pool.ts`: lazy `pg.Pool` with bounded size/timeouts (`DB_*` env vars), idle-client error handler, `withTransaction`, `checkDatabase`, idempotent `closePool`. `server.ts` closes the HTTP server then the pool on SIGINT/SIGTERM. Use parameterized queries only (`$1, $2`).
