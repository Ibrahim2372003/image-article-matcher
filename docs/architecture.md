# Architecture

Monorepo (npm workspaces). `@iam/shared` holds constants and Zod schemas (including the job API contract). `@iam/api` contains the API and the worker; `@iam/web` is a Vite/React shell (UI arrives in milestone 6).

```
apps/api/src
  ai/         provider layer: mock | gemini | ollama, validated output, typed errors      (milestone 3)
  matching/   Mismatch Guard (pure), ranking, pair evaluation, pgvector store               (milestone 4)
  jobs/       lifecycle, PostgreSQL job store, processor, queue, worker, reconciler, usage (milestone 5)
  storage/    magic-byte sniffing, content-addressed image store
  http/ routes/  auth, rate limit, error mapping, POST /jobs, GET /jobs/:id
  db/         pool, migration runner
  server.ts   HTTP API process        worker.ts   separate worker process
```

Flow: `POST /jobs` -> store image + job row (PostgreSQL) -> publish job id (Redis/BullMQ) -> worker claims the job -> classify -> embed -> exact pair evaluation with the deterministic guard -> one guarded write of the result -> `GET /jobs/:id`.

Principles: PostgreSQL is the source of truth; a model never decides (only the guard does); AI/infrastructure failure is never a content decision (`failed`, `decision = NULL`); every transition is audited; similarity alone does not prove factual correctness. Details: `docs/jobs.md`, `docs/policy.md`, `docs/ai-providers.md`, `docs/database.md`.
