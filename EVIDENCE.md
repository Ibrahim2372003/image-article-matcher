## Milestone 3 — Local Verification

Environment: Windows, local project checkout, 2026-11-14.

| Item | Status | Evidence |
|---|---|---|
| `npm test` | VERIFIED | 11 test files passed, 111 tests passed |
| `npm run typecheck` | VERIFIED | Shared, API, and web checks exited successfully |
| `npm run lint` | VERIFIED | ESLint exited successfully |
| `npm run build` | VERIFIED | Shared, API, and web production build completed |
| `git apply --check milestone-3.patch` | VERIFIED | Patch applied cleanly to the local Milestone 2 checkout |
| Real Gemini integration | UNVERIFIED | No live API request performed |
| Real Ollama integration | UNVERIFIED | No live Ollama request performed |

## Milestone 4 (build sandbox, 2026-11-14)

Provider calls use fakes/mock: **no real Gemini or Ollama call was made.** Database checks ran on a temporary PostgreSQL 16.15 + pgvector 0.6.0 installed from Ubuntu packages in the sandbox, **not your Docker container**, inside a disposable schema that the test creates and drops.

| Item | Status | Evidence |
| --- | --- | --- |
| Standard suite, no database configured | VERIFIED | 16 files passed, 1 skipped; 235 tests passed, 11 skipped (the real-DB file) |
| Full suite with `TEST_DATABASE_URL` set | VERIFIED | 17 files, 246 tests passed |
| Offline matching tests (guard 59, ranking 14, service 22, prepare 15, SQL-wiring audit 14) | VERIFIED | 124 passed |
| Guard: each reason, combinations, exact boundaries, NaN/Infinity/out-of-range, empty tags/categories, normalization, config validation | VERIFIED | `guard.test.ts` |
| Real-DB: migrations 001+002 apply, `vector(768)` and HNSW exist, re-run is a no-op | VERIFIED | `integration.test.ts` |
| Real-DB: pgvector ranking equals an independent JS cosine computation (5 decimals) | VERIFIED | `integration.test.ts` |
| Real-DB: accepted, rejected and needs_review rows persisted with reasons, policy, signals, audit events | VERIFIED | `integration.test.ts` |
| Real-DB: idempotent re-run; forced re-run preserves human-reviewed rows | VERIFIED | `integration.test.ts` |
| Real-DB: review committing during a re-run (observed lock wait) is preserved; two simultaneous runs make no duplicates and do not deadlock | VERIFIED | `integration.test.ts` |
| Real-DB: failing record rolls back the whole batch | VERIFIED | `integration.test.ts` |
| Real-DB: cross-model and cross-task-type comparison refused; zero vector -> NaN stored as NULL and rejected | VERIFIED | `integration.test.ts` |
| Test sensitivity: removing the row lock, ignoring reviews, per-row commits | VERIFIED | each mutation made the integration tests fail; originals restored |
| Migration 002 against YOUR Docker database | UNVERIFIED | run `npm run db:migrate` on your machine |
| Matching exposed via API or background job | NOT IMPLEMENTED | milestones 5-6 |
| Guard thresholds calibrated against real embeddings | NOT DONE | defaults are uncalibrated; no evaluation exists |
| Matching quality with Gemini/Ollama embeddings | UNVERIFIED | mock embeddings are lexical hashes only |

## Milestone 5 (build sandbox, 2026-11-14)

Database checks ran on a temporary PostgreSQL 16.15 + pgvector 0.6.0 (Ubuntu packages) in the sandbox, in disposable `it_<random>` schemas, **not your Docker database**. **No Redis was available: no test ran against real Redis.** AI providers are fakes/mock.

| Item | Status | Evidence |
| --- | --- | --- |
| `typecheck`, `lint`, `build` | VERIFIED | all exit 0 |
| Full suite, no services | VERIFIED | 28 files passed, 4 skipped; 489 tests passed, 50 skipped (44 database + 6 Redis) |
| Full suite with scratch PostgreSQL | VERIFIED | 31 files passed, 1 skipped; 533 passed, 6 skipped (the Redis file); no leftover schemas; `public` untouched (before/after fingerprint) |
| Migration 003 on M4-style data (backfill, data preserved, constraints, re-run no-op), on an empty DB, and over a violating row (rolls back completely) | VERIFIED | `pgJobStore.integration.test.ts` |
| M4 matching tests still pass under schema 003 | VERIFIED | `matching/integration.test.ts` (11) |
| Job store: idempotent create, 12 concurrent creates -> 1 job, key conflict, claim/attempt bounds, 12 concurrent claims, stale-worker fencing, terminal immutability, DB transition guards, usage accounting (unknown cost stays NULL), reconcile candidates | VERIFIED | 29 real-database tests |
| Exact pair evaluation equals the top-K path for every article on real pgvector | VERIFIED | `pair.integration.test.ts` (4) |
| Processor, retry/backoff bounds, permanent vs transient, crash recovery, duplicate delivery, stale worker, no accept on failure | VERIFIED (fakes) | `processor.test.ts` (20) |
| Queue adapter, reconciler, worker mapping, submit service incl. publish-failure recovery | VERIFIED (fakes) | `queue/reconciler/submit` tests |
| HTTP API: auth (fail closed), validation, 413/415, MIME spoofing, rate limit, idempotency, 503 recovery, error hygiene, readiness | VERIFIED | `http/api.test.ts` (35) over a real HTTP server with fake stores |
| Image storage: magic bytes, content addressing, atomic write, traversal/symlink, temp cleanup | VERIFIED | `storage` tests (41) |
| Redis-down behaviour of the real BullMQ client: publish deadline works (rejected at the deadline), `ping` false, no crash; real `Worker` accepts the ioredis 6 options and closes | VERIFIED (manual smoke, closed port, no Redis traffic) | script output; not an automated test |
| BullMQ 6.7.6 / ioredis 6.0.0 against a REAL Redis: delivery, retry/backoff, no retry of permanent failures, re-publication | **UNVERIFIED** | `queue.integration.test.ts` (6 tests) skipped: no Redis |
| Migration 003 and the pipeline against YOUR Docker database | **UNVERIFIED** | run the pre-flight in `docs/database.md`, then `npm run db:migrate` |
| Real Gemini/Ollama in the pipeline | **UNVERIFIED** | not run |
| Cost figures | NONE | no prices configured; cost stays unknown |
