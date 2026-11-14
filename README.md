# Image–Article Matcher — AI Content Mismatch Guard

Decides whether an image is semantically appropriate for an article (`accept` / `reject` / `review`) using structured AI output plus a deterministic, configurable policy. Model predictions and policy decisions are kept separate; AI failure never counts as approval.

> **Status:** Milestones 1 (foundation), 2 (database) and 3 (AI provider layer) implemented. See `BUILDLOG.md` for progress and `EVIDENCE.md` for what has actually been verified.

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

## Troubleshooting

- `migration failed: password authentication failed` / `ECONNREFUSED`: check `DATABASE_URL` and that the container is healthy (`docker compose -f infra/docker-compose.yml ps`).
- `was modified after being applied`: never edit an applied migration; add a new one.
- `permission denied to create extension "vector"`: run as a role allowed to create extensions.
- `Invalid environment configuration`: check `.env` against `.env.example`; `GEMINI_API_KEY` is required when `AI_PROVIDER=gemini`.
- `Unsupported AI_PROVIDER` / `GEMINI_API_KEY is required`: fix `.env`; the app refuses to start rather than silently using another provider.
- `invalid embedding ... 768 dimensions`: the embedding model returns another size; use `gemini-embedding-001` (768 requested) or Ollama `nomic-embed-text`.
- `@iam/shared` not found: run `npm run build -w @iam/shared` (typecheck does this automatically).
