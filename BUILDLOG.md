# Build log

## Milestone 1 — Repository foundation (2026-11-13)

- Inspected repo: branch `main`, remote `origin` (HTTPS), 2 commits. Not empty: held a JS prototype nested in `image-article-matcher/`.
- Decision: preserve it via `git mv` to `legacy/v0-js/` rather than overwrite or delete; port incrementally (`docs/legacy-migration.md`).
- Decision: npm workspaces (pnpm not installed in the build environment); lockfile committed.
- Created `packages/shared` (constants, Zod schemas ported from prototype), `apps/api` (env validation, Express app, `/health`), `apps/web` (Vite/React shell), `infra/docker-compose.yml`, ESLint/Prettier/Vitest config, `.env.example`.
- Known blockers: no Docker in the build environment; no GitHub write credentials: `git push` failed with "could not read Username"; work preserved locally and in a git bundle.
- Next: Milestone 2 — DB schema, migrations, Docker infra.

## Milestone 2 — Database schema and migrations (2026-11-13)

- Added `pg` pool module (bounded pool/timeouts, idle error handler, `withTransaction`, idempotent `closePool`), graceful shutdown, and `DB_*` env settings.
- Added a transactional, checksum-verified, advisory-locked migration runner with explicit `db:migrate` / `db:status` commands (not run on API startup).
- `001_init.sql`: articles, images, image_embeddings (`vector(768)` + HNSW), analysis_jobs (status separate from decision), reviews (one per job), append-only job_audit_events.
- Decision: audit immutability and double-review protection enforced in the database, not only in application code.
- Decision: article embeddings deferred to milestone 4.
- Not done by design: AI providers, queues, review endpoints.

## Milestone 3 — AI provider layer (2026-11-14)

- Audited the legacy JS providers (`legacy/v0-js/src/ai`, services). Kept its contract: providers return RAW output; validation and decisions live outside. Ported to TypeScript with typed errors and a validation service. Did not copy the legacy hand-written Gemini `fetch` client.
- Decision: official `@google/genai` SDK for Gemini (wrapped by a minimal injectable interface); plain `fetch` for Ollama (no extra dependency).
- Verified from Google's docs: `gemini-embedding-001` defaults to 3072 dims; 768 needs `outputDimensionality`; non-3072 output must be L2-normalized by the caller. Implemented explicitly; vectors are never padded/truncated.
- Added env vars `OLLAMA_VISION_MODEL`, `OLLAMA_EMBEDDING_MODEL`, `AI_TIMEOUT_MS`.
- Not done by design: matching guard, queue, review APIs, wiring providers into the server.
- Open: `npm audit` reports a high-severity advisory in `zod@3.25.76` (pre-existing, fix is a major upgrade to zod 4); not changed.

## Milestone 4 — Semantic matching and deterministic Mismatch Guard (2026-11-14)

- Built on the actual `origin/main` (`f61fb20`). Ported the legacy guard/matching idea to TypeScript (`apps/api/src/matching/`); legacy untouched.
- **Architecture conflict resolved:** legacy used separate suggestion/reason tables; the current schema is job-centric. Decision: store match results as `analysis_jobs` rows (key `suggest:<image>:<article>`) so the existing reviews and audit trail work; no parallel suggestions table.
- **One migration (`002_matching.sql`), justified:** `image_classifications` and `article_embeddings` did not exist (classification storage; vectors to rank articles) and guard signals for accepted matches had no column (`guard_signals`, `embedding_model`).
- **Policy improvement:** reasons have severity. Uncertainty (`LOW_CLASSIFICATION_CONFIDENCE`, `AMBIGUOUS_MATCH`) -> `review`; wrongness (`BELOW_SIMILARITY_THRESHOLD`, `CATEGORY_MISMATCH`) -> `reject`. Legacy rejected everything. This needs the owner's approval.
- Embedding compatibility is model **and** task type; incompatible spaces are never compared.
- Audit fixes made during development: batch persistence made atomic (one transaction); row lock taken before the review check in a separate statement; `ensureImageEmbedding` now throws `MissingPrerequisiteError` for a missing classification.
- Mutation checks: removing the row lock, ignoring reviews, and per-row commits were each caught by the integration tests.
- Not done: API endpoints, job queue, review endpoints, calibration of thresholds, live provider calls.

## Milestone 5 — Asynchronous job pipeline and HTTP API (2026-11-14)

- Built on `b074bfc`. PostgreSQL is the source of truth; BullMQ/Redis only deliver job ids. Separate worker process.
- **Approved decisions applied:** failed jobs have `decision = NULL`; `kind` column; uploads only (no URL ingestion); API key on both endpoints (fail closed); minimal API (submit, status, health/ready); no review/listing/dashboard endpoints.
- Migration 003 backfills before adding constraints and is transactional; tested against M4-style data and against violating data (clean rollback).
- Exact pair evaluation (`evaluatePair`) because a submitted article may not be in M4's top-K; guard semantics unchanged and asserted equal to the top-K path for every article (SQL rank == JS rank).
- Attempt number as a fencing token; guarded `UPDATE`s plus a database trigger; reconciler for the insert-succeeded / publish-failed window.
- **Defects found by testing real behaviour and fixed:** (1) BullMQ waits forever when Redis is down, so `POST /jobs` would hang instead of answering 503: queue calls now have a deadline, and the reconciler skips a pass when the queue is unreachable; (2) the reconciler's connection could block graceful shutdown: it now fails fast; (3) NFKC normalisation could push a valid category past the database limit (opaque 500): the canonical form is re-validated (400); (4) a stale M4 integration assertion hard-coded the migration list.
- Mutation checks: removing the fencing token, the claim row lock, the idempotency-conflict check, the queue deadline, the canonical validation and the reconciler's queue check were each caught by tests.
- Not verified: BullMQ/ioredis behaviour against a real Redis (tests written, gated on `TEST_REDIS_URL`, never run in the sandbox).
