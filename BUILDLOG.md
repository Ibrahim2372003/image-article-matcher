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
