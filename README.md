# Image–Article Matcher — AI Content Mismatch Guard

Decides whether an image is semantically appropriate for an article (`accept` / `reject` / `review`) using structured AI output plus a deterministic, configurable policy. Model predictions and policy decisions are kept separate; AI failure never counts as approval.

> **Status:** Milestones 1-5 are implemented: foundation, database, AI providers, matching + Mismatch Guard, and the asynchronous job pipeline with an authenticated HTTP API (`POST /jobs`, `GET /jobs/:id`). The review workflow and UI (milestone 6) and evaluation (milestone 7) are not built yet.

## Layout

| Path              | Purpose                                                      |
| ----------------- | ------------------------------------------------------------ |
| `apps/api`        | Node.js + Express + TypeScript API                           |
| `apps/web`        | React + Vite + TypeScript UI                                 |
| `packages/shared` | Shared constants and Zod schemas                             |
| `infra`           | Docker Compose (PostgreSQL + pgvector, Redis)                |
| `scripts`         | Dataset preparation / evaluation (later milestones)          |
| `docs`            | Architecture and migration notes                             |
| `legacy/v0-js`    | Earlier JavaScript prototype, preserved and being ported     |

## Prerequisites

Node.js >= 20.6, npm >= 10, Docker (for PostgreSQL/Redis from milestone 2).

## Setup

```bash
npm install
cp .env.example .env      # keep real keys out of git
npm run typecheck && npm run lint && npm test && npm run build
npm run dev:api           # http://localhost:3000/health
npm run dev:web           # http://localhost:5173
docker compose -f infra/docker-compose.yml up -d   # PostgreSQL/pgvector + Redis
npm run db:migrate        # explicit; never runs on API startup (see docs/database.md)
```

## AI providers

`AI_PROVIDER=mock` (default, offline) | `gemini` (needs `GEMINI_API_KEY`) | `ollama` (local; see `.env.example`). Details, error model and limitations: `docs/ai-providers.md`.

## Jobs and API

Submit an article and an image, a separate worker analyses it, and you read the result (`accept` / `reject` / `review`, or `failed` with no decision). Redis only delivers job ids; PostgreSQL holds all state. Start `npm run dev:api` and `npm run dev:worker` (needs PostgreSQL, Redis and `API_KEY` in `.env`). Endpoints, retry policy, idempotency, shutdown and limitations: `docs/jobs.md`. Apply the new migration with `npm run db:migrate` (see the pre-flight in `docs/database.md`).

## Mismatch Guard and matching

A pure, configurable policy (`accept` / `reject` / `review`, with reason codes `LOW_CLASSIFICATION_CONFIDENCE`, `BELOW_SIMILARITY_THRESHOLD`, `CATEGORY_MISMATCH`, `AMBIGUOUS_MATCH`) plus a matching service that ranks articles for an image with pgvector and persists every evaluation. Thresholds are uncalibrated defaults overridable with `GUARD_MIN_*`. Details, decision table and limitations: `docs/policy.md`. Apply the new migration with `npm run db:migrate` (adds `002_matching.sql`).

Optional real-database tests: set `TEST_DATABASE_URL` to a scratch database and run `npm test`; they use a disposable schema (see `docs/database.md`).

## Troubleshooting
- `503 api_key_not_configured`: set `API_KEY` (16+ characters); the API fails closed without it.
- `503 queue_unavailable`: Redis is unreachable; the job is stored and will be published when you retry the same request or by the worker's reconciler.
- Job stuck in `queued`: is the worker running (`npm run dev:worker`)? `/ready` shows database and queue status.

- `migration failed: password authentication failed` / `ECONNREFUSED`: check `DATABASE_URL` and that the container is healthy (`docker compose -f infra/docker-compose.yml ps`).
- `was modified after being applied`: never edit an applied migration; add a new one.
- `permission denied to create extension "vector"`: run as a role allowed to create extensions.
- `Invalid environment configuration`: check `.env` against `.env.example`; `GEMINI_API_KEY` is required when `AI_PROVIDER=gemini`.
- `Unsupported AI_PROVIDER` / `GEMINI_API_KEY is required`: fix `.env`; the app refuses to start rather than silently using another provider.
- `invalid embedding ... 768 dimensions`: the embedding model returns another size; use `gemini-embedding-001` (768 requested) or Ollama `nomic-embed-text`.
- `incompatible_embedding_model`: the image and article embeddings come from different models or task types; re-embed with the same provider.
- `missing_prerequisite`: classify and embed the image and embed the articles first (`ensureImageClassification`, `ensureImageEmbedding`, `ensureArticleEmbedding`).
- `@iam/shared` not found: run `npm run build -w @iam/shared` (typecheck does this automatically).
