# Evidence

Only items marked VERIFIED were actually run (build sandbox, Node v22.23.4, npm 10.9.9, 2026-11-13).

| Item                                                   | Status     | Evidence                                              |
| ------------------------------------------------------ | ---------- | ----------------------------------------------------- |
| `npm run typecheck` (shared, api, web)                 | VERIFIED   | exit 0                                                |
| `npm run lint` (ESLint)                                | VERIFIED   | exit 0, no output                                     |
| `npm run format:check` (Prettier)                      | VERIFIED   | "All matched files use Prettier code style!"          |
| `npm test` (Vitest)                                    | VERIFIED   | 3 files, 15 tests passed (mock-free unit tests only)  |
| `npm run build` (shared, api, web/Vite)                | VERIFIED   | web build emitted `dist/`                             |
| API `GET /health` and 404 envelope against running server | VERIFIED | curl returned 200 + valid JSON, 404 error envelope    |
| Docker Compose (PostgreSQL/pgvector, Redis)            | UNVERIFIED | no Docker in build environment; verify on your machine |
| Gemini / Ollama integration                            | UNVERIFIED | not implemented yet; legacy code never run            |
| Legacy prototype (`legacy/v0-js`)                      | UNVERIFIED | not executed; its test/eval dirs are missing          |
| Evaluation metrics, dataset licenses                   | NONE       | no dataset or evaluation exists yet                   |
| Push to GitHub `main`                                  | FAILED     | `fatal: could not read Username for https://github.com` (no credentials in sandbox); commit exists locally only |

## Milestone 2 (build sandbox, 2026-11-13)

Verified against a **temporary PostgreSQL 16.x + pgvector 0.6.0 installed from Ubuntu packages in the sandbox, not your Docker container** (the Docker image may ship a newer pgvector). Password auth (scram-sha-256) enabled.

| Item                                                                 | Status   | Evidence                                                                 |
| -------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------ |
| Unit tests (38 total: config, redaction, migration logic w/ fake DB, shutdown, schema/shared-constant sync) | VERIFIED | `npm test`: 6 files, 38 passed |
| `db:migrate` applies 001; second run reports "up to date"            | VERIFIED | real DB, tracking row `1 init`                                           |
| Tables created; `image_embeddings.embedding` is `vector(768)`; HNSW index exists | VERIFIED | catalog queries                                                |
| Constraints (decision/status rules, idempotency key, one review per job, blank notes, wrong vector dimension, FK RESTRICT) | VERIFIED | each violation raised the expected error; valid rows accepted |
| Audit table rejects UPDATE/DELETE/TRUNCATE                           | VERIFIED | trigger error raised                                                     |
| `updated_at` trigger                                                 | VERIFIED | advanced across transactions                                             |
| Failed migration rolls back, records nothing, releases lock          | VERIFIED | forced bad `002`: no partial table, 1 recorded row, 0 advisory locks      |
| Edited applied migration is rejected                                 | VERIFIED | `checksum_mismatch`                                                      |
| Wrong password / unreachable DB: non-zero exit, password not printed | VERIFIED | `password authentication failed`, 0 occurrences of the password          |
| Migrations against YOUR Docker database                              | UNVERIFIED | run `npm run db:migrate` locally (see report)                            |
| Concurrent runners serialized by advisory lock                       | UNVERIFIED | lock taken/released verified; no two-process race test run               |
| HNSW index search performance / recall                               | UNVERIFIED | only a single-row distance query was run                                 |
