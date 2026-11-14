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
